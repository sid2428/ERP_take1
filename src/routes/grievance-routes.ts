/**
 * Grievances for students and faculty (T8-2): raise, track, and discuss. Mounted at
 * /student/grievances and /faculty/grievances. Faculty also see the grievances the admin assigned
 * to them and can reply on those. Only the admin moves a grievance on (src/routes/admin/grievance-routes.ts).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { friendlyDbError, transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/http-error.js';
import { flash } from '../middleware/auth.js';
import {
  GRIEVANCE_CATEGORIES, actAs, getGrievanceFor, getThread, insertComment, listAssignedTo, listRaisedBy, statusPill,
} from '../queries/grievance-queries.js';
import { idParam } from './admin/helpers.js';

export const grievanceRouter = Router();

/** /student/grievances or /faculty/grievances, whichever this request came through. */
const base = (req: Request): string => req.baseUrl;

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

grievanceRouter.get('/new', (req, res) => {
  res.render('shared/grievance-new', {
    title: 'Raise a grievance', nav: 'grievances', base: base(req), categories: GRIEVANCE_CATEGORIES,
  });
});

const newSchema = z.object({
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
  try {
    const id = await transaction(async (db) => {
      await actAs(db, user.userId);
      const { rows } = await db.query<{ grievance_id: number }>(
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description)
         VALUES ($1, $2, $3, $4, $5) RETURNING grievance_id`,
        [user.userId, user.role, v.category, v.subject, v.description]);
      const grievanceId = rows[0]!.grievance_id;
      await audit(req, { action: 'GRIEVANCE_CREATE', entity: 'grievance', entityId: grievanceId,
        details: { category: v.category, subject: v.subject } }, db);
      return grievanceId;
    });
    flash(req, 'success', `Grievance #${id} submitted. The academic office will review it.`);
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
    isRaiser: g.raised_by === req.user!.userId,
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
