/**
 * Grievances for students and faculty (T8-2): raise, track, and discuss. Mounted at
 * /student/grievances and /faculty/grievances. A student's grievance about a course goes straight
 * to the teacher who teaches them that course (migration 094); that teacher replies and resolves or
 * rejects it, which locks it until an admin unlocks it. General grievances, and those raised by
 * faculty, go to the admin (src/routes/admin/grievance-routes.ts). Faculty also see the grievances
 * assigned to them and can reply on those.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { friendlyDbError, transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/http-error.js';
import { flash } from '../middleware/auth.js';
import {
  GRIEVANCE_CATEGORIES, actAs, getCourseTeachers, getGrievanceFor, getThread, insertComment, isClosed,
  listAssignedTo, listRaisedBy, statusPill, type GrievanceRow,
} from '../queries/grievance-queries.js';
import { idParam } from './admin/helpers.js';

export const grievanceRouter = Router();

/** /student/grievances or /faculty/grievances, whichever this request came through. */
const base = (req: Request): string => req.baseUrl;

/** The signed-in teacher handles this course grievance: they may move it on and close it. */
const isHandler = (req: Request, g: GrievanceRow): boolean =>
  req.user!.role === 'faculty' && g.course_id !== null && g.assigned_to === req.user!.facultyId;

grievanceRouter.get('/', async (req, res) => {
  const user = req.user!;
  const [mine, assigned] = await Promise.all([
    listRaisedBy(user.userId),
    user.facultyId ? listAssignedTo(user.facultyId) : Promise.resolve([]),
  ]);
  res.render('shared/grievances', {
    title: 'Grievances', nav: 'grievances', base: base(req), mine, assigned, statusPill,
    isFaculty: user.role === 'faculty',
  });
});

grievanceRouter.get('/new', async (req, res) => {
  const user = req.user!;
  const teachers = user.role === 'student' && user.studentId ? await getCourseTeachers(user.studentId) : [];
  res.render('shared/grievance-new', {
    title: 'Raise a grievance', nav: 'grievances', base: base(req), categories: GRIEVANCE_CATEGORIES,
    isStudent: user.role === 'student', teachers,
  });
});

const optionalId = z.union([z.literal(''), z.coerce.number().int().positive()]).optional();
const newSchema = z.object({
  about: z.enum(['course', 'general']).default('general'),
  course_id: optionalId,
  faculty_id: optionalId,
  category: z.enum(GRIEVANCE_CATEGORIES, { message: 'Choose a category' }),
  subject: z.string().trim().min(5, 'The subject needs at least 5 characters').max(120, 'Keep the subject under 120 characters'),
  description: z.string().trim().min(10, 'Describe the problem in at least 10 characters')
    .max(4000, 'Keep the description under 4,000 characters'),
});

grievanceRouter.post('/', async (req, res) => {
  const user = req.user!;
  const parsed = newSchema.safeParse(req.body);
  if (!parsed.success) {
    flash(req, 'error', parsed.error.issues.map((i) => i.message).join(' · '));
    res.redirect(`${base(req)}/new`);
    return;
  }
  const v = parsed.data;

  // a course grievance goes to the chosen teacher of that course, or by default its first (lecture) teacher
  let courseId: number | null = null;
  let teacher: { id: number; name: string } | null = null;
  if (v.about === 'course') {
    if (user.role !== 'student' || !user.studentId) {
      flash(req, 'error', 'Only students can raise a grievance about a course.');
      res.redirect(`${base(req)}/new`);
      return;
    }
    const options = (await getCourseTeachers(user.studentId)).filter((t) => t.course_id === v.course_id);
    const pick = options.find((t) => t.faculty_id === v.faculty_id) ?? options[0];
    if (!pick) {
      flash(req, 'error', 'Choose one of your courses for this term.');
      res.redirect(`${base(req)}/new`);
      return;
    }
    courseId = pick.course_id;
    teacher = { id: pick.faculty_id, name: pick.faculty_name };
  }

  try {
    const id = await transaction(async (db) => {
      await actAs(db, user.userId);
      const { rows } = await db.query<{ grievance_id: number }>(
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description, course_id, assigned_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING grievance_id`,
        [user.userId, user.role, v.category, v.subject, v.description, courseId, teacher?.id ?? null]);
      const grievanceId = rows[0]!.grievance_id;
      await audit(req, { action: 'GRIEVANCE_CREATE', entity: 'grievance', entityId: grievanceId,
        details: { category: v.category, subject: v.subject, ...(courseId ? { courseId, facultyId: teacher!.id } : {}) } }, db);
      return grievanceId;
    });
    flash(req, 'success', teacher
      ? `Grievance #${id} sent to ${teacher.name}, who teaches you this course.`
      : `Grievance #${id} submitted. The academic office will review it.`);
    res.redirect(`${base(req)}/${id}`);
  } catch (err) {
    const message = friendlyDbError(err);
    if (!message) throw err;
    flash(req, 'error', message);
    res.redirect(`${base(req)}/new`);
  }
});

grievanceRouter.get('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const g = await getGrievanceFor(req.user!.userId, id);
  if (!g) throw notFound('Grievance');
  const thread = await getThread(id);
  res.render('shared/grievance-detail', {
    title: `Grievance #${id}`, nav: 'grievances', base: base(req), g, thread, statusPill,
    isRaiser: g.raised_by === req.user!.userId, isHandler: isHandler(req, g),
  });
});

const commentSchema = z.object({
  body: z.string().trim().min(1, 'Write a reply first').max(2000, 'Keep replies under 2,000 characters'),
});

grievanceRouter.post('/:id/comments', async (req, res) => {
  const id = idParam(req.params.id);
  const user = req.user!;
  const g = await getGrievanceFor(user.userId, id);
  if (!g) throw notFound('Grievance');
  const parsed = commentSchema.safeParse(req.body);
  if (!parsed.success) {
    flash(req, 'error', parsed.error.issues.map((i) => i.message).join(' · '));
  } else {
    try {
      await transaction(async (db) => {
        await actAs(db, user.userId);
        await insertComment(db, id, user.userId, parsed.data.body);
        await audit(req, { action: 'GRIEVANCE_COMMENT', entity: 'grievance', entityId: id }, db);
      });
      flash(req, 'success', 'Reply added.');
    } catch (err) {
      const message = friendlyDbError(err);
      if (!message) throw err;
      flash(req, 'error', message);
    }
  }
  res.redirect(`${base(req)}/${id}`);
});

// ---------------------------------------------------------------- teacher actions on course grievances

/** A problem the teacher can fix (shown as a red message, not a server error). */
class ActionError extends Error {}

/** Load a course grievance the signed-in teacher handles, run the action, flash and go back to it. */
async function handlerAction(req: Request, res: Response, run: (g: GrievanceRow) => Promise<string>): Promise<void> {
  const id = idParam(typeof req.params.id === 'string' ? req.params.id : undefined);
  const g = await getGrievanceFor(req.user!.userId, id);
  if (!g || !isHandler(req, g)) throw notFound('Grievance');
  try {
    flash(req, 'success', await run(g));
  } catch (err) {
    const message = err instanceof ActionError ? err.message : friendlyDbError(err);
    if (!message) throw err;
    flash(req, 'error', message);
  }
  res.redirect(`${base(req)}/${id}`);
}

grievanceRouter.post('/:id/progress', (req, res) => handlerAction(req, res, async (g) => {
  if (g.status !== 'Open') throw new ActionError('Only an open grievance can be moved to In progress.');
  await transaction(async (db) => {
    await actAs(db, req.user!.userId);
    await db.query(`UPDATE grievance SET status = 'In progress' WHERE grievance_id = $1 AND status = 'Open'`, [g.grievance_id]);
    await audit(req, { action: 'GRIEVANCE_PROGRESS', entity: 'grievance', entityId: g.grievance_id }, db);
  });
  return 'Marked as In progress. The student has been told you are looking into it.';
}));

const resolveSchema = z.object({
  outcome: z.enum(['Resolved', 'Rejected'], { message: 'Choose Resolve or Reject' }),
  note: z.string().trim().min(5, 'Write a note of at least 5 characters for the student')
    .max(2000, 'Keep the note under 2,000 characters'),
});

grievanceRouter.post('/:id/resolve', (req, res) => handlerAction(req, res, async (g) => {
  if (isClosed(g.status)) throw new ActionError('This grievance is already closed.');
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) throw new ActionError(parsed.error.issues.map((i) => i.message).join(' · '));
  const v = parsed.data;
  await transaction(async (db) => {
    await db.query('CALL resolve_grievance($1, $2, $3, $4)', [g.grievance_id, req.user!.userId, v.outcome, v.note]);
    await audit(req, { action: v.outcome === 'Resolved' ? 'GRIEVANCE_RESOLVE' : 'GRIEVANCE_REJECT',
      entity: 'grievance', entityId: g.grievance_id, details: { note: v.note } }, db);
  });
  return `Grievance #${g.grievance_id} ${v.outcome === 'Resolved' ? 'resolved' : 'rejected'} and locked. Only the academic office can reopen it.`;
}));
