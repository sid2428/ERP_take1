/**
 * Notice board (T8-1), mounted at /student/notices, /faculty/notices and /admin/inbox. Live status
 * alerts (attendance shortage, fees pending) sit above the notices; personal notices with a link
 * open their target through /:id/go, which also marks them read.
 * Faculty can also post to the divisions they teach and withdraw their own notices; the database
 * enforces both rules (migrations/081-notices.sql). The admin's pages are in admin/notice-routes.ts.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { friendlyDbError, pool, query, queryOne, transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/http-error.js';
import { flash } from '../middleware/auth.js';
import { actAs } from '../queries/grievance-queries.js';
import {
  NOTICE_CATEGORIES, alertsFor, audienceLabel, boardFor, categoryPill, markAllRead, markRead, noticeFor, postNotice, reachOf,
  targetsOf, teachingDivisions, type NoticeKind,
} from '../queries/notice-queries.js';
import { idParam } from './admin/helpers.js';

export const noticeRouter = Router();

const base = (req: Request): string => req.baseUrl;

const noticeKind = (value: unknown): NoticeKind => value === 'personal' ? 'personal' : value === 'announcements' ? 'announcements' : 'all';

function noticeFilters(req: Request): { category: string; kind: NoticeKind } {
  return {
    category: typeof req.query.category === 'string' && (NOTICE_CATEGORIES as readonly string[]).includes(req.query.category)
      ? req.query.category : '',
    kind: noticeKind(req.query.kind),
  };
}

function requireFaculty(req: Request): number {
  if (req.user?.role !== 'faculty' || !req.user.facultyId) throw forbidden();
  return req.user.facultyId;
}

noticeRouter.get('/', async (req, res) => {
  const user = req.user!;
  const { category, kind } = noticeFilters(req);
  const filterHref = (nextKind: NoticeKind): string => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (nextKind !== 'all') params.set('kind', nextKind);
    const queryString = params.toString();
    return `${base(req)}${queryString ? `?${queryString}` : ''}`;
  };
  const categoryHref = (nextCategory: string): string => {
    const params = new URLSearchParams();
    if (nextCategory) params.set('category', nextCategory);
    if (kind !== 'all') params.set('kind', kind);
    const queryString = params.toString();
    return `${base(req)}${queryString ? `?${queryString}` : ''}`;
  };
  const [notices, alerts, mine] = await Promise.all([
    boardFor(user.userId, category, kind),
    alertsFor(user.userId),
    user.role === 'faculty'
      ? query<{ notice_id: number; title: string; category: string; posted_at: Date; withdrawn_at: Date | null; expires_at: Date | null }>(
        `SELECT notice_id, title, category, posted_at, withdrawn_at, expires_at FROM notice
         WHERE posted_by = $1 ORDER BY posted_at DESC LIMIT 50`, [user.userId])
      : Promise.resolve([]),
  ]);
  const ids = mine.map((n) => n.notice_id);
  const [targets, reach] = await Promise.all([targetsOf(ids), reachOf(ids)]);
  res.render('shared/notices', {
    title: user.role === 'admin' ? 'Inbox' : 'Notices', nav: user.role === 'admin' ? 'inbox' : 'notices',
    base: base(req), notices, alerts, category, isAdmin: user.role === 'admin', categories: NOTICE_CATEGORIES, categoryPill,
    kind, filterHref, categoryHref,
    isFaculty: user.role === 'faculty',
    mine: mine.map((n) => ({ ...n, audience: audienceLabel(targets.get(n.notice_id) ?? []), reach: reach.get(n.notice_id) })),
    unread: notices.filter((n) => !n.is_read).length,
  });
});

noticeRouter.post('/read-all', async (req, res) => {
  const category = typeof req.body.category === 'string' && (NOTICE_CATEGORIES as readonly string[]).includes(req.body.category)
    ? req.body.category : '';
  const kind = noticeKind(req.body.kind);
  const n = await transaction(async (db) => markAllRead(db, req.user!.userId, category, kind));
  flash(req, 'success', n ? `${n} notice${n === 1 ? '' : 's'} marked as read.` : 'Everything was already read.');
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (kind !== 'all') params.set('kind', kind);
  const queryString = params.toString();
  res.redirect(`${base(req)}${queryString ? `?${queryString}` : ''}`);
});

// ---------------------------------------------------------------- faculty: post / withdraw
noticeRouter.get('/new', async (req, res) => {
  const facultyId = requireFaculty(req);
  res.render('shared/notice-new', {
    title: 'Post a notice', nav: 'notices', base: base(req), categories: NOTICE_CATEGORIES,
    divisions: await teachingDivisions(facultyId),
  });
});

const optionalDate = z.string().trim().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Enter a valid date').optional()
  .transform((v) => (v ? v : null));
export const noticeFields = {
  title: z.string().trim().min(5, 'The title needs at least 5 characters').max(150, 'Keep the title under 150 characters'),
  body: z.string().trim().min(10, 'Write at least 10 characters').max(5000, 'Keep the notice under 5,000 characters'),
  category: z.enum(NOTICE_CATEGORIES, { message: 'Choose a category' }),
  is_important: z.literal('on').optional().transform((v) => v === 'on'),
  expires_on: optionalDate,
};
/** A date-only expiry means "until the end of that day" in college time. */
export const expiryOf = (date: string | null): string | null => (date ? `${date}T23:59:59+05:30` : null);

const facultySchema = z.object({
  ...noticeFields,
  division_ids: z.union([z.string(), z.array(z.string())], { message: 'Choose at least one division' })
    .transform((v) => (Array.isArray(v) ? v : [v]).map(Number))
    .pipe(z.array(z.number().int().positive()).min(1, 'Choose at least one division')),
});

noticeRouter.post('/', async (req, res) => {
  requireFaculty(req);
  const parsed = facultySchema.safeParse(req.body);
  if (!parsed.success) {
    flash(req, 'error', parsed.error.issues.map((i) => i.message).join(' · '));
    res.redirect(`${base(req)}/new`);
    return;
  }
  const v = parsed.data;
  try {
    const id = await transaction(async (db) => {
      await actAs(db, req.user!.userId);
      const noticeId = await postNotice(db, req.user!.userId, { ...v, expires_at: expiryOf(v.expires_on) },
        [...new Set(v.division_ids)].map((d) => ({ division_id: d })));
      await audit(req, { action: 'NOTICE_POST', entity: 'notice', entityId: noticeId,
        details: { title: v.title, divisions: v.division_ids } }, db);
      return noticeId;
    });
    const reach = (await reachOf([id])).get(id);
    flash(req, 'success', `Notice posted to ${reach?.recipients ?? 0} students.`);
    res.redirect(`${base(req)}/${id}`);
  } catch (err) {
    const message = friendlyDbError(err);
    if (!message) throw err;
    flash(req, 'error', message);
    res.redirect(`${base(req)}/new`);
  }
});

noticeRouter.post('/:id/withdraw', async (req: Request, res: Response) => {
  requireFaculty(req);
  const id = idParam(typeof req.params.id === 'string' ? req.params.id : undefined);
  try {
    await transaction(async (db) => {
      await actAs(db, req.user!.userId);
      const r = await db.query(
        'UPDATE notice SET withdrawn_at = now() WHERE notice_id = $1 AND posted_by = $2 AND withdrawn_at IS NULL', [id, req.user!.userId]);
      if (r.rowCount === 0) throw notFound('Notice');
      await audit(req, { action: 'NOTICE_WITHDRAW', entity: 'notice', entityId: id }, db);
    });
    flash(req, 'success', 'Notice withdrawn. Students no longer see it.');
  } catch (err) {
    const message = friendlyDbError(err);
    if (!message) throw err;
    flash(req, 'error', message);
  }
  res.redirect(base(req));
});

// ---------------------------------------------------------------- detail
/** Open what a personal notice is about (e.g. the grievance), marking the notice read on the way. */
noticeRouter.get('/:id/go', async (req, res) => {
  const id = idParam(req.params.id);
  const n = await noticeFor(req.user!.userId, id);
  if (!n) throw notFound('Notice');
  if (!n.is_read) await markRead(pool, req.user!.userId, id);
  res.redirect(n.link ?? `${base(req)}/${id}`);
});

noticeRouter.get('/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const user = req.user!;
  let n = await noticeFor(user.userId, id);
  // faculty can still open their own notices after withdrawing them or when they are not in the audience
  const own = n ? null : await queryOne<{ notice_id: number }>('SELECT notice_id FROM notice WHERE notice_id = $1 AND posted_by = $2', [id, user.userId]);
  if (!n && !own) throw notFound('Notice');
  if (n && !n.is_read) await markRead(pool, user.userId, id);
  if (!n) {
    n = await queryOne(`SELECT n.notice_id, n.title, n.body, n.category, n.is_important, n.posted_at, n.expires_at, n.posted_by,
                               p.display_name AS posted_by_name, p.role AS posted_by_role, NULL AS read_at, true AS is_read
                        FROM notice n LEFT JOIN v_user_profile p ON p.user_id = n.posted_by WHERE n.notice_id = $1`, [id]);
  }
  const isPoster = n!.posted_by === user.userId;
  const [targets, reach, status] = await Promise.all([
    targetsOf([id]), isPoster ? reachOf([id]) : Promise.resolve(new Map()),
    queryOne<{ withdrawn_at: Date | null }>('SELECT withdrawn_at FROM notice WHERE notice_id = $1', [id]),
  ]);
  res.render('shared/notice-detail', {
    title: n!.title, nav: user.role === 'admin' ? 'inbox' : 'notices', base: base(req), n, categoryPill, isPoster,
    audience: audienceLabel(targets.get(id) ?? []), reach: reach.get(id), withdrawnAt: status?.withdrawn_at ?? null,
  });
});
