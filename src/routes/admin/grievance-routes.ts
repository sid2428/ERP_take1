/** Admin: grievances by teacher, the general queue, assignment, replies, closing, and unlocking (T8-2, 094). */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { friendlyDbError, query, queryOne, transaction } from '../../db.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/http-error.js';
import { pageInfo, parsePage, withQuery } from '../../lib/pagination.js';
import { flash } from '../../middleware/auth.js';
import {
  GRIEVANCE_CATEGORIES, GRIEVANCE_STATUSES, actAs, getGrievanceFor, getThread, insertComment, statusPill, type GrievanceRow,
} from '../../queries/grievance-queries.js';
import { idParam } from './helpers.js';

export const grievanceAdminRouter = Router();

/** A problem the admin can fix (shown as a red message, not a server error). */
class ActionError extends Error {}

/** Validate, run, flash and redirect back to the grievance; DB rule violations become readable messages. */
async function action<S extends z.ZodType>(
  req: Request, res: Response, schema: S, run: (id: number, data: z.infer<S>) => Promise<string>,
): Promise<void> {
  const id = idParam(typeof req.params.id === 'string' ? req.params.id : undefined);
  if (!(await queryOne('SELECT 1 FROM grievance WHERE grievance_id = $1', [id]))) throw notFound('Grievance');
  const back = `/admin/grievances/${id}`;
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    flash(req, 'error', parsed.error.issues.map((i) => i.message).join(' · '));
    res.redirect(back);
    return;
  }
  try {
    flash(req, 'success', await run(id, parsed.data));
  } catch (err) {
    const message = err instanceof ActionError ? err.message : friendlyDbError(err);
    if (!message) throw err;
    flash(req, 'error', message);
  }
  res.redirect(back);
}

// ---------------------------------------------------------------- queue
// Two views. "By teacher" (default): the admin picks a department and a teacher and sees only that
// teacher's grievances, mostly students' course grievances, which the teacher handles (migration
// 094); locked ones can be unlocked from their page. "General": the queue of grievances with no
// course (fees, facilities, faculty-raised ...), which the admin still handles as before.
const ACTIVE = 'active';     // default status filter: Open + In progress
const LOCKED = 'locked';     // Resolved + Rejected

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Status filter value -> the statuses it covers. */
function statusesFor(filter: string): string[] {
  if (filter === ACTIVE) return ['Open', 'In progress'];
  if (filter === LOCKED) return ['Resolved', 'Rejected'];
  return (GRIEVANCE_STATUSES as readonly string[]).includes(filter) ? [filter] : [...GRIEVANCE_STATUSES];
}

interface GrievanceCounts { total: number; active: number; locked: number; }

/** General grievances (no course: fees, facilities, faculty-raised ...) still waiting for the admin. */
function generalWaiting(): Promise<{ open: number; faculty: number }> {
  return queryOne<{ open: number; faculty: number }>(`
    SELECT count(*)::int AS open, count(*) FILTER (WHERE raised_by_role = 'faculty')::int AS faculty
    FROM grievance WHERE course_id IS NULL AND status IN ('Open', 'In progress')`)
    .then((r) => r ?? { open: 0, faculty: 0 });
}

grievanceAdminRouter.get('/grievances', async (req, res) => {
  if (req.query.view === 'general') {
    await generalQueue(req, res);
    return;
  }

  const filters = { dept: str(req.query.dept, 10), faculty: str(req.query.faculty, 15).toUpperCase(), status: str(req.query.status, 20) };
  const departments = await query<{ dept_id: string; dept_name: string } & GrievanceCounts>(`
    SELECT d.dept_id, d.dept_name,
           count(g.grievance_id)::int AS total,
           count(*) FILTER (WHERE g.status IN ('Open', 'In progress'))::int AS active,
           count(*) FILTER (WHERE g.status IN ('Resolved', 'Rejected'))::int AS locked
    FROM department d
    LEFT JOIN faculty f ON f.dept_id = d.dept_id
    LEFT JOIN grievance g ON g.assigned_to = f.faculty_id
    WHERE d.is_active
    GROUP BY d.dept_id ORDER BY d.dept_name`);

  // a faculty code alone is enough (it tells us the department); after switching department the
  // previously chosen teacher no longer applies
  const found = filters.faculty === '' ? undefined
    : await queryOne<{ faculty_id: number; faculty_code: string; name: string; dept_id: string; designation: string }>(
      `SELECT faculty_id, faculty_code, first_name || ' ' || last_name AS name, dept_id, designation::text AS designation
       FROM faculty WHERE faculty_code = $1`, [filters.faculty]);
  if (found && filters.dept === '') filters.dept = found.dept_id;
  const teacher = found && found.dept_id === filters.dept ? found : undefined;
  const dept = departments.find((d) => d.dept_id === filters.dept);

  const [teachers, rows, waiting] = await Promise.all([
    dept ? query<{ faculty_code: string; name: string; designation: string } & GrievanceCounts>(`
      SELECT f.faculty_code, f.first_name || ' ' || f.last_name AS name, f.designation::text AS designation,
             count(g.grievance_id)::int AS total,
             count(*) FILTER (WHERE g.status IN ('Open', 'In progress'))::int AS active,
             count(*) FILTER (WHERE g.status IN ('Resolved', 'Rejected'))::int AS locked
      FROM faculty f LEFT JOIN grievance g ON g.assigned_to = f.faculty_id
      WHERE f.dept_id = $1 AND (f.status = 'Active' OR g.grievance_id IS NOT NULL)
      GROUP BY f.faculty_id ORDER BY count(g.grievance_id) = 0, f.first_name, f.last_name`, [dept.dept_id]) : [],
    teacher ? query<GrievanceRow>(`
      SELECT * FROM v_grievance_overview WHERE assigned_to = $1 AND status::text = ANY($2::text[])
      ORDER BY (status IN ('Resolved', 'Rejected')) DESC, updated_at DESC LIMIT 200`,
      [teacher.faculty_id, statusesFor(filters.status)]) : [],
    generalWaiting(),
  ]);

  res.render('admin/grievances', {
    title: 'Grievances', nav: 'grievances', view: 'teacher', filters, departments, dept, teachers, teacher, rows,
    statusPill, statuses: GRIEVANCE_STATUSES, waiting,
  });
});

async function generalQueue(req: Request, res: Response): Promise<void> {
  const statusParam = str(req.query.status, 20);
  const filters = {
    view: 'general',
    status: statusParam === '' && !('status' in req.query) ? ACTIVE : statusParam,
    category: str(req.query.category, 20),
    role: str(req.query.role, 10),
    q: str(req.query.q, 60),
  };
  const page = parsePage(req.query.page);
  const where = `course_id IS NULL AND status::text = ANY($1::text[])
    AND ($2::text = '' OR category::text = $2::text)
    AND ($3::text = '' OR raised_by_role::text = $3::text)
    AND ($4::text = '' OR subject ILIKE '%' || $4::text || '%' OR raised_by_login ILIKE $4::text || '%'
         OR raised_by_name ILIKE '%' || $4::text || '%' OR grievance_id::text = $4::text)`;
  const params = [statusesFor(filters.status), filters.category, filters.role, filters.q];

  const [rows, count, totals, waiting] = await Promise.all([
    query<GrievanceRow>(`SELECT * FROM v_grievance_overview WHERE ${where}
      ORDER BY (status = 'Open') DESC, created_at ${filters.status === ACTIVE ? 'ASC' : 'DESC'}
      LIMIT $5 OFFSET $6`, [...params, page.limit, page.offset]),
    queryOne<{ n: number }>(`SELECT count(*) AS n FROM v_grievance_overview WHERE ${where}`, params),
    queryOne<{ open: number; in_progress: number; resolved: number; rejected: number }>(`
      SELECT count(*) FILTER (WHERE status = 'Open')::int AS open,
             count(*) FILTER (WHERE status = 'In progress')::int AS in_progress,
             count(*) FILTER (WHERE status = 'Resolved')::int AS resolved,
             count(*) FILTER (WHERE status = 'Rejected')::int AS rejected
      FROM grievance WHERE course_id IS NULL`),
    generalWaiting(),
  ]);

  res.render('admin/grievances', {
    title: 'Grievances', nav: 'grievances', view: 'general', rows, filters, totals: totals!, statusPill, waiting,
    categories: GRIEVANCE_CATEGORIES, statuses: GRIEVANCE_STATUSES,
    pager: pageInfo(page, count?.n ?? 0), qs: (o: Record<string, unknown>) => withQuery(filters, o),
  });
}

// ---------------------------------------------------------------- detail
grievanceAdminRouter.get('/grievances/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const g = await getGrievanceFor(req.user!.userId, id);
  if (!g) throw notFound('Grievance');
  const [thread, faculty] = await Promise.all([
    getThread(id),
    // suggestions for the assignee box: active faculty of the raiser's department, HOD first
    query<{ faculty_code: string; name: string; designation: string; is_hod: boolean }>(`
      SELECT f.faculty_code, f.first_name || ' ' || f.last_name AS name, f.designation::text AS designation,
             d.hod_faculty_id = f.faculty_id AS is_hod
      FROM faculty f JOIN department d ON d.dept_id = f.dept_id
      WHERE f.status = 'Active' AND ($1::text IS NULL OR f.dept_id = $1::text)
        AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.faculty_id = f.faculty_id AND u.user_id = $2)
      ORDER BY (d.hod_faculty_id = f.faculty_id) DESC, f.faculty_code LIMIT 120`, [g.raised_by_dept, g.raised_by]),
  ]);
  // back to the teacher's list for a course grievance, else to the general queue
  const back = g.course_id && g.assigned_code
    ? `/admin/grievances${withQuery({ faculty: g.assigned_code })}` : '/admin/grievances?view=general';
  res.render('admin/grievance-detail', {
    title: `Grievance #${id}`, nav: 'grievances', base: '/admin/grievances', back, g, thread, faculty, statusPill,
    isRaiser: false,
  });
});

// ---------------------------------------------------------------- actions
const noFields = z.object({});

grievanceAdminRouter.post('/grievances/:id/progress', (req, res) => action(req, res, noFields, async (id) => {
  await transaction(async (db) => {
    await actAs(db, req.user!.userId);
    const r = await db.query(`UPDATE grievance SET status = 'In progress' WHERE grievance_id = $1 AND status = 'Open'`, [id]);
    if (r.rowCount === 0) throw new ActionError('Only an open grievance can be moved to In progress.');
    await audit(req, { action: 'GRIEVANCE_PROGRESS', entity: 'grievance', entityId: id }, db);
  });
  return 'Marked as In progress.';
}));

const assignSchema = z.object({
  faculty_code: z.string().trim().toUpperCase().max(15, 'That is not a faculty code'),
});

grievanceAdminRouter.post('/grievances/:id/assign', (req, res) => action(req, res, assignSchema, async (id, v) => {
  return transaction(async (db) => {
    let facultyId: number | null = null;
    let name = '';
    if (v.faculty_code === '' && (await db.query('SELECT 1 FROM grievance WHERE grievance_id = $1 AND course_id IS NOT NULL', [id])).rowCount) {
      throw new ActionError('A course grievance always needs a teacher. Enter the code of the teacher who should take it over.');
    }
    if (v.faculty_code !== '') {
      const { rows } = await db.query<{ faculty_id: number; name: string }>(
        `SELECT faculty_id, first_name || ' ' || last_name AS name FROM faculty WHERE faculty_code = $1`, [v.faculty_code]);
      if (!rows[0]) throw new ActionError(`No faculty member has the code ${v.faculty_code}.`);
      facultyId = rows[0].faculty_id;
      name = rows[0].name;
    }
    await db.query('CALL assign_grievance($1, $2, $3)', [id, facultyId, req.user!.userId]);
    await audit(req, { action: facultyId ? 'GRIEVANCE_ASSIGN' : 'GRIEVANCE_UNASSIGN', entity: 'grievance', entityId: id,
      details: facultyId ? { facultyCode: v.faculty_code } : undefined }, db);
    return facultyId ? `Assigned to ${name} (${v.faculty_code}). They can now see it and reply.` : 'Assignment removed.';
  });
}));

const commentSchema = z.object({
  body: z.string().trim().min(1, 'Write a reply first').max(2000, 'Keep replies under 2,000 characters'),
});

grievanceAdminRouter.post('/grievances/:id/comments', (req, res) => action(req, res, commentSchema, async (id, v) => {
  await transaction(async (db) => {
    await actAs(db, req.user!.userId);
    await insertComment(db, id, req.user!.userId, v.body);
    await audit(req, { action: 'GRIEVANCE_COMMENT', entity: 'grievance', entityId: id }, db);
  });
  return 'Reply added.';
}));

const resolveSchema = z.object({
  outcome: z.enum(['Resolved', 'Rejected'], { message: 'Choose Resolve or Reject' }),
  note: z.string().trim().min(5, 'Write a note of at least 5 characters for the person who raised it')
    .max(2000, 'Keep the note under 2,000 characters'),
});

grievanceAdminRouter.post('/grievances/:id/resolve', (req, res) => action(req, res, resolveSchema, async (id, v) => {
  await transaction(async (db) => {
    await db.query('CALL resolve_grievance($1, $2, $3, $4)', [id, req.user!.userId, v.outcome, v.note]);
    await audit(req, { action: v.outcome === 'Resolved' ? 'GRIEVANCE_RESOLVE' : 'GRIEVANCE_REJECT',
      entity: 'grievance', entityId: id, details: { note: v.note } }, db);
  });
  return v.outcome === 'Resolved' ? `Grievance #${id} resolved.` : `Grievance #${id} rejected.`;
}));

// A locked (Resolved / Rejected) grievance goes back to In progress with the same teacher.
const unlockSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason of at least 5 characters for unlocking')
    .max(2000, 'Keep the reason under 2,000 characters'),
});

grievanceAdminRouter.post('/grievances/:id/unlock', (req, res) => action(req, res, unlockSchema, async (id, v) => {
  await transaction(async (db) => {
    await db.query('CALL unlock_grievance($1, $2, $3)', [id, req.user!.userId, v.reason]);
    await audit(req, { action: 'GRIEVANCE_UNLOCK', entity: 'grievance', entityId: id, details: { reason: v.reason } }, db);
  });
  return `Grievance #${id} unlocked. It is In progress again, and the student and the teacher have been told.`;
}));
