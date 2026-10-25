/** Admin: grievance queue, assignment to faculty, replies, and closing as Resolved / Rejected (T8-2). */
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
const ACTIVE = 'active';     // default filter: Open + In progress

grievanceAdminRouter.get('/grievances', async (req, res) => {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const statusParam = str(req.query.status, 20);
  const filters = {
    status: statusParam === '' && !('status' in req.query) ? ACTIVE : statusParam,
    category: str(req.query.category, 20),
    role: str(req.query.role, 10),
    q: str(req.query.q, 60),
  };
  const statuses = filters.status === ACTIVE ? ['Open', 'In progress']
    : (GRIEVANCE_STATUSES as readonly string[]).includes(filters.status) ? [filters.status] : [...GRIEVANCE_STATUSES];
  const page = parsePage(req.query.page);
  const where = `status::text = ANY($1::text[])
    AND ($2::text = '' OR category::text = $2::text)
    AND ($3::text = '' OR raised_by_role::text = $3::text)
    AND ($4::text = '' OR subject ILIKE '%' || $4::text || '%' OR raised_by_login ILIKE $4::text || '%'
         OR raised_by_name ILIKE '%' || $4::text || '%' OR grievance_id::text = $4::text)`;
  const params = [statuses, filters.category, filters.role, filters.q];

  const [rows, count, stats] = await Promise.all([
    query<GrievanceRow>(`SELECT * FROM v_grievance_overview WHERE ${where}
      ORDER BY (status = 'Open') DESC, created_at ${filters.status === ACTIVE ? 'ASC' : 'DESC'}
      LIMIT $5 OFFSET $6`, [...params, page.limit, page.offset]),
    queryOne<{ n: number }>(`SELECT count(*) AS n FROM v_grievance_overview WHERE ${where}`, params),
    query('SELECT * FROM v_grievance_resolution_stats'),
  ]);
  const totals = stats.reduce((t, s) => ({
    open: t.open + s.open, in_progress: t.in_progress + s.in_progress,
    resolved: t.resolved + s.resolved, rejected: t.rejected + s.rejected,
  }), { open: 0, in_progress: 0, resolved: 0, rejected: 0 });

  res.render('admin/grievances', {
    title: 'Grievances', nav: 'grievances', rows, filters, stats, totals, statusPill,
    categories: GRIEVANCE_CATEGORIES, statuses: GRIEVANCE_STATUSES,
    pager: pageInfo(page, count?.n ?? 0), qs: (o: Record<string, unknown>) => withQuery(filters, o),
  });
});

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
  res.render('admin/grievance-detail', {
    title: `Grievance #${id}`, nav: 'grievances', base: '/admin/grievances', g, thread, faculty, statusPill,
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
