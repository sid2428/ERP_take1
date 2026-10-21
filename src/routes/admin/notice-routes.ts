/** Admin: post notices to any audience, see reach and reads, withdraw (T8-1). */
import { Router } from 'express';
import { z } from 'zod';
import { friendlyDbError, query, queryOne, transaction } from '../../db.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/http-error.js';
import { pageInfo, parsePage, withQuery } from '../../lib/pagination.js';
import { flash } from '../../middleware/auth.js';
import { actAs } from '../../queries/grievance-queries.js';
import {
  NOTICE_CATEGORIES, audienceLabel, categoryPill, postNotice, reachOf, targetsOf, type TargetSpec,
} from '../../queries/notice-queries.js';
import { expiryOf, noticeFields } from '../notice-routes.js';
import { idParam } from './helpers.js';

export const noticeAdminRouter = Router();

/** A problem the admin can fix (shown as a red message, not a server error). */
class ActionError extends Error {}

interface NoticeRow {
  notice_id: number; title: string; category: string; is_important: boolean; posted_at: Date;
  expires_at: Date | null; withdrawn_at: Date | null; posted_by_name: string; posted_by_role: string | null;
}

// ---------------------------------------------------------------- list
noticeAdminRouter.get('/notices', async (req, res) => {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const filters = { state: str(req.query.state, 10), category: str(req.query.category, 20), q: str(req.query.q, 60) };
  const page = parsePage(req.query.page);
  const where = `($1::text = '' OR ($1::text = 'live' AND n.withdrawn_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > now()))
                   OR ($1::text = 'expired' AND n.withdrawn_at IS NULL AND n.expires_at <= now())
                   OR ($1::text = 'withdrawn' AND n.withdrawn_at IS NOT NULL))
     AND ($2::text = '' OR n.category::text = $2::text)
     AND ($3::text = '' OR n.title ILIKE '%' || $3::text || '%')`;
  const params = [filters.state, filters.category, filters.q];
  const [rows, count] = await Promise.all([
    query<NoticeRow>(`SELECT n.notice_id, n.title, n.category, n.is_important, n.posted_at, n.expires_at, n.withdrawn_at,
                             COALESCE(p.display_name, 'System') AS posted_by_name, p.role::text AS posted_by_role
                      FROM notice n LEFT JOIN v_user_profile p ON p.user_id = n.posted_by
                      WHERE ${where} ORDER BY n.posted_at DESC LIMIT $4 OFFSET $5`, [...params, page.limit, page.offset]),
    queryOne<{ n: number }>(`SELECT count(*) AS n FROM notice n WHERE ${where}`, params),
  ]);
  const ids = rows.map((r) => r.notice_id);
  const [targets, reach] = await Promise.all([targetsOf(ids), reachOf(ids)]);
  res.render('admin/notices', {
    title: 'Notices', nav: 'notices', filters, categories: NOTICE_CATEGORIES, categoryPill,
    rows: rows.map((r) => ({ ...r, audience: audienceLabel(targets.get(r.notice_id) ?? []), reach: reach.get(r.notice_id) })),
    pager: pageInfo(page, count?.n ?? 0), qs: (o: Record<string, unknown>) => withQuery(filters, o),
  });
});

// ---------------------------------------------------------------- post
noticeAdminRouter.get('/notices/new', async (_req, res) => {
  const departments = await query<{ dept_id: string; dept_name: string }>(
    'SELECT dept_id, dept_name FROM department WHERE is_active ORDER BY dept_id');
  const divisions = await query<{ division_code: string }>(
    'SELECT division_code FROM division WHERE academic_session_id = current_session_id() ORDER BY division_code');
  res.render('admin/notice-new', {
    title: 'Post a notice', nav: 'notices', categories: NOTICE_CATEGORIES, departments, divisions,
  });
});

const roleOrAll = z.enum(['', 'student', 'faculty']).default('');
const adminSchema = z.object({
  ...noticeFields,
  audience: z.enum(['everyone', 'role', 'department', 'year', 'division'], { message: 'Choose who should receive it' }),
  role: z.enum(['student', 'faculty', 'admin']).default('student'),
  dept_role: roleOrAll,
  dept_id: z.string().trim().max(10).default(''),
  year: z.coerce.number().int().min(1).max(4).default(1),
  year_dept_id: z.string().trim().max(10).default(''),
  division_codes: z.string().trim().max(2000).default(''),
});

noticeAdminRouter.post('/notices', async (req, res) => {
  const parsed = adminSchema.safeParse(req.body);
  if (!parsed.success) {
    flash(req, 'error', parsed.error.issues.map((i) => i.message).join(' · '));
    res.redirect('/admin/notices/new');
    return;
  }
  const v = parsed.data;
  try {
    let targets: TargetSpec[];
    switch (v.audience) {
      case 'everyone': targets = [{}]; break;
      case 'role': targets = [{ role: v.role }]; break;
      case 'department':
        if (!v.dept_id) throw new ActionError('Choose a department.');
        targets = [{ dept_id: v.dept_id, ...(v.dept_role ? { role: v.dept_role } : {}) }];
        break;
      case 'year':
        targets = [{ role: 'student', year_of_study: v.year, ...(v.year_dept_id ? { dept_id: v.year_dept_id } : {}) }];
        break;
      case 'division': {
        const codes = [...new Set(v.division_codes.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean))];
        if (codes.length === 0) throw new ActionError('Enter at least one division code, e.g. CSE-Y2-A.');
        const found = await query<{ division_id: number; division_code: string }>(
          `SELECT division_id, division_code FROM division
           WHERE academic_session_id = current_session_id() AND division_code = ANY($1::text[])`, [codes]);
        const missing = codes.filter((c) => !found.some((f) => f.division_code === c));
        if (missing.length) throw new ActionError(`No division this term has the code ${missing.join(', ')}.`);
        targets = found.map((f) => ({ division_id: f.division_id }));
        break;
      }
    }
    const id = await transaction(async (db) => {
      await actAs(db, req.user!.userId);
      const noticeId = await postNotice(db, req.user!.userId, { ...v, expires_at: expiryOf(v.expires_on) }, targets);
      await audit(req, { action: 'NOTICE_POST', entity: 'notice', entityId: noticeId,
        details: { title: v.title, audience: v.audience, targets } }, db);
      return noticeId;
    });
    const reach = (await reachOf([id])).get(id);
    flash(req, 'success', `Notice posted to ${(reach?.recipients ?? 0).toLocaleString('en-IN')} people.`);
    res.redirect(`/admin/notices/${id}`);
  } catch (err) {
    const message = err instanceof ActionError ? err.message : friendlyDbError(err);
    if (!message) throw err;
    flash(req, 'error', message);
    res.redirect('/admin/notices/new');
  }
});

// ---------------------------------------------------------------- detail + withdraw
noticeAdminRouter.get('/notices/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const n = await queryOne<NoticeRow & { body: string; withdrawn_by_name: string | null }>(
    `SELECT n.*, COALESCE(p.display_name, 'System') AS posted_by_name, p.role::text AS posted_by_role,
            w.display_name AS withdrawn_by_name
     FROM notice n LEFT JOIN v_user_profile p ON p.user_id = n.posted_by
     LEFT JOIN v_user_profile w ON w.user_id = n.withdrawn_by WHERE n.notice_id = $1`, [id]);
  if (!n) throw notFound('Notice');
  const [targets, reach] = await Promise.all([targetsOf([id]), reachOf([id])]);
  res.render('admin/notice-detail', {
    title: n.title, nav: 'notices', n, categoryPill, audience: audienceLabel(targets.get(id) ?? []), reach: reach.get(id),
  });
});

noticeAdminRouter.post('/notices/:id/withdraw', async (req, res) => {
  const id = idParam(req.params.id);
  try {
    await transaction(async (db) => {
      await actAs(db, req.user!.userId);
      const r = await db.query('UPDATE notice SET withdrawn_at = now() WHERE notice_id = $1 AND withdrawn_at IS NULL', [id]);
      if (r.rowCount === 0) throw notFound('Notice');
      await audit(req, { action: 'NOTICE_WITHDRAW', entity: 'notice', entityId: id }, db);
    });
    flash(req, 'success', 'Notice withdrawn. Nobody sees it on their board any more.');
  } catch (err) {
    const message = friendlyDbError(err);
    if (!message) throw err;
    flash(req, 'error', message);
  }
  res.redirect(`/admin/notices/${id}`);
});
