/** Notice queries (T8-1). Audience rules live in migrations/081-notices.sql. */
import { query, queryOne, type Db } from '../db.js';

export const NOTICE_CATEGORIES = ['General', 'Academic', 'Exam', 'Fees', 'Placement', 'Event'] as const;
export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

export interface UserNotice {
  notice_id: number | null;
  notification_id: number | null;
  item_type: 'notice' | 'notification';
  notification_kind: string | null;
  title: string;
  body: string;
  category: NoticeCategory;
  is_important: boolean;
  posted_at: Date;
  expires_at: Date | null;
  posted_by: number | null;
  posted_by_name: string;
  posted_by_role: string | null;
  read_at: Date | null;
  is_read: boolean;
  link: string | null;
  source: string | null;
  is_personal: boolean;
}

/** A live status alert (attendance shortage, fees pending): computed, not stored. */
export interface UserAlert { kind: string; severity: 'high' | 'normal'; title: string; body: string; link: string | null; }

export interface NoticeTarget {
  role: string | null;
  dept_id: string | null;
  year_of_study: number | null;
  division_id: number | null;
  division_code: string | null;
  user_id: number | null;
  login_id: string | null;
}

/** Target JSON accepted by post_notice(). */
export interface TargetSpec { role?: string; dept_id?: string; year_of_study?: number; division_id?: number; user_id?: number; }

export type NoticeKind = 'all' | 'announcements' | 'personal';

export function alertsFor(userId: number): Promise<UserAlert[]> {
  return query<UserAlert>('SELECT * FROM user_alerts($1)', [userId]);
}

/** Unread stored notices visible to this user; the view applies recipient, expiry and withdrawal rules. */
export function unreadNoticeCount(userId: number): Promise<number> {
  return queryOne<{ unread: number }>(
    'SELECT count(*)::int AS unread FROM v_user_notices WHERE user_id = $1 AND NOT is_read', [userId]
  ).then((row) => row?.unread ?? 0);
}

/** The notices this user should see, important ones first. */
export function boardFor(userId: number, category = '', kind: NoticeKind = 'all', limit = 100): Promise<UserNotice[]> {
  return query<UserNotice>(
    `SELECT * FROM v_user_notices
     WHERE user_id = $1
       AND ($2::text = '' OR category::text = $2::text)
       AND ($3::text = 'all' OR ($3::text = 'personal' AND is_personal)
                         OR ($3::text = 'announcements' AND NOT is_personal))
     ORDER BY is_important DESC, posted_at DESC LIMIT $4`, [userId, category, kind, limit]);
}

export function noticeFor(userId: number, noticeId: number): Promise<UserNotice | undefined> {
  return queryOne<UserNotice>(
    `SELECT * FROM v_user_notices WHERE user_id = $1 AND item_type = 'notice' AND notice_id = $2`, [userId, noticeId]);
}

/** Legacy personal notice lookup retained so old /:id URLs remain usable after backfill. */
export function legacyNoticeFor(userId: number, noticeId: number): Promise<UserNotice | undefined> {
  return queryOne<UserNotice>(
    `SELECT n.notice_id, NULL::int AS notification_id, 'notice'::text AS item_type, NULL::varchar(20) AS notification_kind,
            n.title, n.body, n.category, n.is_important, n.posted_at, n.expires_at, n.posted_by,
            COALESCE(p.display_name, 'Academic office') AS posted_by_name, p.role AS posted_by_role,
            r.read_at, r.read_at IS NOT NULL AS is_read, n.link, n.source, true AS is_personal
     FROM notice n
     JOIN notice_target t ON t.notice_id = n.notice_id AND t.user_id = $1
     LEFT JOIN notice_read r ON r.notice_id = n.notice_id AND r.user_id = $1
     LEFT JOIN v_user_profile p ON p.user_id = n.posted_by
     WHERE n.notice_id = $2`, [userId, noticeId]);
}

/** A dedicated notification is addressed only to its stored recipient. */
export function notificationFor(userId: number, notificationId: number): Promise<UserNotice | undefined> {
  return queryOne<UserNotice>(
    `SELECT * FROM v_user_notices WHERE user_id = $1 AND item_type = 'notification' AND notification_id = $2`,
    [userId, notificationId]);
}

/** Latest notices for the dashboard card, plus how many are unread. Pass a shared count to avoid a duplicate query. */
export async function noticeSummary(userId: number, limit = 4, unread?: number): Promise<{ latest: UserNotice[]; unread: number; alerts: UserAlert[] }> {
  const [latest, counts, alerts] = await Promise.all([
    query<UserNotice>('SELECT * FROM v_user_notices WHERE user_id = $1 ORDER BY is_important DESC, posted_at DESC LIMIT $2', [userId, limit]),
    unread === undefined ? unreadNoticeCount(userId) : Promise.resolve(unread),
    alertsFor(userId),
  ]);
  return { latest, unread: counts, alerts };
}

export async function markRead(db: Db, userId: number, noticeId: number): Promise<void> {
  await db.query('INSERT INTO notice_read (notice_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [noticeId, userId]);
}

export async function markNotificationRead(db: Db, userId: number, notificationId: number): Promise<void> {
  await db.query('UPDATE notification SET read_at = COALESCE(read_at, now()) WHERE notification_id = $1 AND user_id = $2',
    [notificationId, userId]);
}

export async function markAllRead(db: Db, userId: number, category = '', kind: NoticeKind = 'all'): Promise<number> {
  const notices = await db.query(
    `INSERT INTO notice_read (notice_id, user_id)
     SELECT notice_id, user_id FROM v_user_notices
      WHERE user_id = $1 AND item_type = 'notice' AND NOT is_read
        AND ($2::text = '' OR category::text = $2::text)
        AND ($3::text = 'all' OR ($3::text = 'announcements' AND NOT is_personal)
                              OR ($3::text = 'personal' AND is_personal))
     ON CONFLICT DO NOTHING`, [userId, category, kind]);
  const notifications = await db.query(
    `UPDATE notification SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND ($2::text = '' OR category::text = $2::text)
        AND ($3::text IN ('all', 'personal'))`, [userId, category, kind]);
  return (notices.rowCount ?? 0) + (notifications.rowCount ?? 0);
}

/** Targets of several notices, keyed by notice id. */
export async function targetsOf(noticeIds: number[]): Promise<Map<number, NoticeTarget[]>> {
  const rows = noticeIds.length === 0 ? [] : await query<NoticeTarget & { notice_id: number }>(
    `SELECT t.notice_id, t.role::text AS role, t.dept_id, t.year_of_study, t.division_id, d.division_code,
            t.user_id, u.login_id
     FROM notice_target t LEFT JOIN division d ON d.division_id = t.division_id
     LEFT JOIN app_user u ON u.user_id = t.user_id
     WHERE t.notice_id = ANY($1::int[]) ORDER BY t.target_id`, [noticeIds]);
  const map = new Map<number, NoticeTarget[]>();
  for (const r of rows) map.set(r.notice_id, [...(map.get(r.notice_id) ?? []), r]);
  return map;
}

/** Recipients and reads of several notices, keyed by notice id. */
export async function reachOf(noticeIds: number[]): Promise<Map<number, { recipients: number; reads: number }>> {
  const rows = noticeIds.length === 0 ? [] : await query<{ notice_id: number; recipients: number; reads: number }>(
    'SELECT notice_id, recipients, reads FROM v_notice_reach WHERE notice_id = ANY($1::int[])', [noticeIds]);
  return new Map(rows.map((r) => [r.notice_id, { recipients: r.recipients, reads: r.reads }]));
}

const ROLE_LABEL: Record<string, string> = { student: 'Students', faculty: 'Faculty', admin: 'Admin' };

/** Human-readable audience, e.g. "Everyone", "Students · CSE · Year 2", "Division CSE-Y2-A". */
export function audienceLabel(targets: NoticeTarget[]): string {
  if (targets.length === 0) return '–';
  return targets.map((t) => {
    if (t.user_id) return `Only ${t.login_id ?? 'one person'}`;
    if (t.division_id) return `Division ${t.division_code ?? t.division_id}`;
    const parts = [t.role ? ROLE_LABEL[t.role] ?? t.role : 'Everyone'];
    if (t.dept_id) parts.push(t.dept_id);
    if (t.year_of_study) parts.push(`Year ${t.year_of_study}`);
    return parts.join(' · ');
  }).join(', ');
}

/** Divisions this faculty member teaches in the current session (the only ones they may post to). */
export function teachingDivisions(facultyId: number): Promise<{ division_id: number; division_code: string; year_of_study: number; students: number }[]> {
  return query(`
    SELECT d.division_id, d.division_code, d.year_of_study,
           (SELECT count(*) FROM student_section ss WHERE ss.division_id = d.division_id)::int AS students
    FROM division d
    WHERE d.academic_session_id = current_session_id()
      AND EXISTS (SELECT 1 FROM teaching_assignment ta WHERE ta.division_id = d.division_id AND ta.faculty_id = $1
                    AND ta.academic_session_id = current_session_id())
    ORDER BY d.division_code`, [facultyId]);
}

/** Post through the contract function; returns the new notice id. */
export async function postNotice(db: Db, postedBy: number, v: {
  title: string; body: string; category: NoticeCategory; is_important: boolean; expires_at: string | null;
}, targets: TargetSpec[]): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    'SELECT post_notice($1, $2, $3, $4, $5::jsonb, $6, $7) AS id',
    [postedBy, v.title, v.body, v.category, JSON.stringify(targets), v.is_important, v.expires_at]);
  return rows[0]!.id;
}

/** CSS pill variant per category (public/css/app.css). */
export function categoryPill(category: string): string {
  return ({ Exam: 'v', Fees: 'o', Placement: 't', Event: 'g', Academic: '', General: 'n' } as Record<string, string>)[category] ?? 'n';
}
