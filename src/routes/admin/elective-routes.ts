/** Admin: elective windows, offerings, open/close and seat allocation (T3-2.2). */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { friendlyDbError, query, queryOne, transaction } from '../../db.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/http-error.js';
import { flash } from '../../middleware/auth.js';
import { idParam } from './helpers.js';

export const electiveRouter = Router();

/** A problem the admin can fix (shown as a red message, not a server error). */
class ActionError extends Error {}

interface WindowRow {
  window_id: number;
  academic_session_id: string;
  semester_no: number;
  elective_group: 'O1' | 'H1';
  status: 'Scheduled' | 'Open' | 'Closed' | 'Allocated';
  opens_at: Date;
  closes_at: Date;
  max_choices: number;
  allocated_at: Date | null;
}

/** Same idea as handleForm in helpers.ts, plus ActionError for friendly "you can't do that" messages. */
async function formAction<S extends z.ZodType>(
  req: Request, res: Response, schema: S, redirectTo: string,
  run: (data: z.infer<S>) => Promise<string | { message: string; redirect: string }>,
): Promise<void> {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    flash(req, 'error', parsed.error.issues.map((i) => i.message).join(' · '));
    res.redirect(redirectTo);
    return;
  }
  let target = redirectTo;
  try {
    const outcome = await run(parsed.data);
    if (typeof outcome === 'string') {
      flash(req, 'success', outcome);
    } else {
      flash(req, 'success', outcome.message);
      target = outcome.redirect;
    }
  } catch (err) {
    const message = err instanceof ActionError ? err.message : friendlyDbError(err);
    if (!message) throw err;
    flash(req, 'error', message);
  }
  res.redirect(target);
}

async function getWindow(id: number): Promise<WindowRow> {
  const w = await queryOne<WindowRow>('SELECT * FROM elective_window WHERE window_id = $1', [id]);
  if (!w) throw notFound('Elective window');
  return w;
}

// ---------------------------------------------------------------- list + create
electiveRouter.get('/electives', async (_req, res) => {
  const windows = await query(`
    SELECT w.*,
           (SELECT count(*) FROM elective_window_offering wo WHERE wo.window_id = w.window_id)::int AS offerings,
           (SELECT count(DISTINCT p.student_id) FROM elective_preference p WHERE p.window_id = w.window_id)::int AS applicants
    FROM elective_window w ORDER BY w.created_at DESC`);
  const sessions = await query('SELECT session_id FROM academic_session ORDER BY start_date DESC');
  res.render('admin/electives', { title: 'Elective windows', nav: 'electives', windows, sessions });
});

const datetime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Enter a valid date and time');
const windowSchema = z.object({
  academic_session_id: z.string().min(1, 'Choose a session'),
  semester_no: z.coerce.number().int().min(1).max(12),
  elective_group: z.enum(['O1', 'H1']),
  opens_at: datetime,
  closes_at: datetime,
  max_choices: z.coerce.number().int().min(1).max(5),
}).refine((v) => v.closes_at > v.opens_at, { message: 'Closing time must be after the opening time' });

electiveRouter.post('/electives', (req, res) => formAction(req, res, windowSchema, '/admin/electives', async (v) => {
  const id = await transaction(async (db) => {
    const { rows } = await db.query<{ window_id: number }>(
      `INSERT INTO elective_window (academic_session_id, semester_no, elective_group, opens_at, closes_at, max_choices)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING window_id`,
      [v.academic_session_id, v.semester_no, v.elective_group, v.opens_at, v.closes_at, v.max_choices]);
    const windowId = rows[0]!.window_id;
    await audit(req, { action: 'ELECTIVE_WINDOW_CREATE', entity: 'elective_window', entityId: windowId, details: v }, db);
    return windowId;
  });
  return { message: 'Window created. Add offerings, then open it.', redirect: `/admin/electives/${id}` };
}));

// ---------------------------------------------------------------- detail
electiveRouter.get('/electives/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const w = await getWindow(id);

  const summary = await query('SELECT * FROM v_elective_allocation_summary WHERE window_id = $1 ORDER BY course_code, section_name', [id]);
  // existing offerings of this term that fit the window's elective group and semester
  const available = await query(`
    SELECT o.offering_id, c.course_code, c.course_name, o.section_name, o.max_seats
    FROM course_offering o JOIN course c ON c.course_id = o.course_id
    WHERE o.academic_session_id = $2
      AND NOT EXISTS (SELECT 1 FROM elective_window_offering wo WHERE wo.window_id = $1 AND wo.offering_id = o.offering_id)
      AND EXISTS (SELECT 1 FROM program_curriculum pc WHERE pc.course_id = o.course_id
                   AND pc.elective_group = $3 AND pc.semester_no = $4)
    ORDER BY c.course_code, o.section_name`, [id, w.academic_session_id, w.elective_group, w.semester_no]);
  // courses that could get a brand-new offering
  const courses = await query(`
    SELECT DISTINCT c.course_id, c.course_code, c.course_name
    FROM program_curriculum pc JOIN course c ON c.course_id = pc.course_id
    WHERE pc.elective_group = $1 AND pc.semester_no = $2 ORDER BY c.course_code`, [w.elective_group, w.semester_no]);
  const allocations = await query(`
    SELECT a.merit_position, s.student_number, s.first_name || ' ' || s.last_name AS student_name,
           a.merit_score, a.merit_basis, c.course_code, a.preference_rank
    FROM elective_allocation a
    JOIN student s ON s.student_id = a.student_id
    LEFT JOIN course_offering o ON o.offering_id = a.offering_id
    LEFT JOIN course c ON c.course_id = o.course_id
    WHERE a.window_id = $1 ORDER BY a.merit_position LIMIT 200`, [id]);

  res.render('admin/elective-detail', {
    title: `${w.elective_group === 'O1' ? 'Open elective' : 'Honors'} window`, nav: 'electives',
    w, summary, available, courses, allocations,
  });
});

// ---------------------------------------------------------------- offerings
const addOfferingSchema = z.object({ offering_id: z.coerce.number().int().positive('Choose an offering') });

electiveRouter.post('/electives/:id/offerings', (req, res) => {
  const id = idParam(req.params.id);
  return formAction(req, res, addOfferingSchema, `/admin/electives/${id}`, async (v) => {
    const w = await getWindow(id);
    if (w.status === 'Allocated') throw new ActionError('Seats were already allocated for this window.');
    await transaction(async (db) => {
      const r = await db.query(
        `INSERT INTO elective_window_offering (window_id, offering_id, academic_session_id)
         SELECT $1, o.offering_id, o.academic_session_id FROM course_offering o WHERE o.offering_id = $2`,
        [id, v.offering_id]);
      if (r.rowCount === 0) throw new ActionError('That offering does not exist.');
      await audit(req, { action: 'ELECTIVE_OFFERING_ADD', entity: 'elective_window', entityId: id,
        details: { offeringId: v.offering_id } }, db);
    });
    return 'Offering added to the window.';
  });
});

const newOfferingSchema = z.object({
  course_id: z.coerce.number().int().positive('Choose a course'),
  section_name: z.string().trim().min(1, 'Enter a section name').max(5, 'Section name is at most 5 characters'),
  max_seats: z.coerce.number().int().min(1, 'Seats must be at least 1').max(500),
});

electiveRouter.post('/electives/:id/new-offering', (req, res) => {
  const id = idParam(req.params.id);
  return formAction(req, res, newOfferingSchema, `/admin/electives/${id}`, async (v) => {
    const w = await getWindow(id);
    if (w.status === 'Allocated') throw new ActionError('Seats were already allocated for this window.');
    await transaction(async (db) => {
      const fits = await db.query(
        `SELECT 1 FROM program_curriculum WHERE course_id = $1 AND elective_group = $2 AND semester_no = $3 LIMIT 1`,
        [v.course_id, w.elective_group, w.semester_no]);
      if (fits.rows.length === 0) {
        throw new ActionError(`That course is not placed as a ${w.elective_group} elective in semester ${w.semester_no}.`);
      }
      const { rows } = await db.query<{ offering_id: number }>(
        `INSERT INTO course_offering (course_id, academic_session_id, section_name, max_seats)
         VALUES ($1, $2, $3, $4) RETURNING offering_id`,
        [v.course_id, w.academic_session_id, v.section_name, v.max_seats]);
      const offeringId = rows[0]!.offering_id;
      await db.query(
        `INSERT INTO elective_window_offering (window_id, offering_id, academic_session_id) VALUES ($1, $2, $3)`,
        [id, offeringId, w.academic_session_id]);
      await audit(req, { action: 'ELECTIVE_OFFERING_CREATE', entity: 'course_offering', entityId: offeringId,
        details: { windowId: id, ...v } }, db);
    });
    return `Offering ${v.section_name} created with ${v.max_seats} seats and added to the window.`;
  });
});

// ---------------------------------------------------------------- open / close / allocate
const noFields = z.object({});

electiveRouter.post('/electives/:id/open', (req, res) => {
  const id = idParam(req.params.id);
  return formAction(req, res, noFields, `/admin/electives/${id}`, async () => {
    await transaction(async (db) => {
      const { rows } = await db.query<{ status: string; offerings: number; still_future: boolean }>(
        `SELECT w.status, w.closes_at > now() AS still_future,
                (SELECT count(*) FROM elective_window_offering wo WHERE wo.window_id = w.window_id)::int AS offerings
         FROM elective_window w WHERE w.window_id = $1 FOR UPDATE`, [id]);
      const w = rows[0];
      if (!w) throw notFound('Elective window');
      if (w.status !== 'Scheduled' && w.status !== 'Closed') throw new ActionError(`A ${w.status.toLowerCase()} window cannot be opened.`);
      if (w.offerings === 0) throw new ActionError('Add at least one offering before opening the window.');
      if (!w.still_future) throw new ActionError('The closing time has already passed. Create a new window.');
      await db.query(`UPDATE elective_window SET status = 'Open' WHERE window_id = $1`, [id]);
      await audit(req, { action: 'ELECTIVE_WINDOW_OPEN', entity: 'elective_window', entityId: id }, db);
    });
    return 'Window opened. Students can now rank their choices.';
  });
});

electiveRouter.post('/electives/:id/close', (req, res) => {
  const id = idParam(req.params.id);
  return formAction(req, res, noFields, `/admin/electives/${id}`, async () => {
    await transaction(async (db) => {
      const r = await db.query(
        `UPDATE elective_window SET status = 'Closed' WHERE window_id = $1 AND status = 'Open'`, [id]);
      if (r.rowCount === 0) throw new ActionError('Only an open window can be closed.');
      await audit(req, { action: 'ELECTIVE_WINDOW_CLOSE', entity: 'elective_window', entityId: id }, db);
    });
    return 'Window closed. You can now run the allocation.';
  });
});

electiveRouter.post('/electives/:id/allocate', (req, res) => {
  const id = idParam(req.params.id);
  return formAction(req, res, noFields, `/admin/electives/${id}`, async () => {
    const w = await getWindow(id);
    if (w.status === 'Allocated') throw new ActionError('Seats were already allocated for this window.');
    if (w.status !== 'Closed') throw new ActionError('Close the window before allocating seats.');
    return transaction(async (db) => {
      await db.query('CALL allocate_electives($1, $2)', [id, req.user?.userId ?? null]);
      const { rows } = await db.query<{ seated: number; unseated: number }>(
        `SELECT count(*) FILTER (WHERE offering_id IS NOT NULL)::int AS seated,
                count(*) FILTER (WHERE offering_id IS NULL)::int AS unseated
         FROM elective_allocation WHERE window_id = $1`, [id]);
      const t = rows[0] ?? { seated: 0, unseated: 0 };
      await audit(req, { action: 'ELECTIVE_ALLOCATE', entity: 'elective_window', entityId: id, details: t }, db);
      return `Allocation done: ${t.seated} students got a seat, ${t.unseated} did not.`;
    });
  });
});
