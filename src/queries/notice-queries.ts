/** Notice queries (T8-1). Audience rules live in migrations/081-notices.sql. */
import { query, queryOne, type Db } from '../db.js';

export const NOTICE_CATEGORIES = ['General', 'Academic', 'Exam', 'Fees', 'Placement', 'Event'] as const;
export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

export interface UserNotice {
  notice_id: number;
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
}

export interface NoticeTarget {
  role: string | null;
  dept_id: string | null;
  year_of_study: number | null;
  division_id: number | null;
  division_code: string | null;
}

/** Target JSON accepted by post_notice(). */
export interface TargetSpec { role?: string; dept_id?: string; year_of_study?: number; division_id?: number; }

/** The notices this user should see, important ones first. */
export function boardFor(userId: number, category = '', limit = 100): Promise<UserNotice[]> {
  return query<UserNotice>(
    `SELECT * FROM v_user_notices WHERE user_id = $1 AND ($2::text = '' OR category::text = $2::text)
     ORDER BY is_important DESC, posted_at DESC LIMIT $3`, [userId, category, limit]);
}

export function noticeFor(userId: number, noticeId: number): Promise<UserNotice | undefined> {
  return queryOne<UserNotice>('SELECT * FROM v_user_notices WHERE user_id = $1 AND notice_id = $2', [userId, noticeId]);
}

/** Latest notices for the dashboard card, plus how many are unread. */
export async function noticeSummary(userId: number, limit = 4): Promise<{ latest: UserNotice[]; unread: number }> {
  const [latest, counts] = await Promise.all([
    query<UserNotice>('SELECT * FROM v_user_notices WHERE user_id = $1 ORDER BY is_important DESC, posted_at DESC LIMIT $2', [userId, limit]),
    queryOne<{ unread: number }>('SELECT count(*) FILTER (WHERE NOT is_read)::int AS unread FROM v_user_notices WHERE user_id = $1', [userId]),
  ]);
  return { latest, unread: counts?.unread ?? 0 };
}

export async function markRead(db: Db, userId: number, noticeId: number): Promise<void> {
  await db.query('INSERT INTO notice_read (notice_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [noticeId, userId]);
}

export async function markAllRead(db: Db, userId: number): Promise<number> {
  const r = await db.query(
    `INSERT INTO notice_read (notice_id, user_id)
     SELECT notice_id, user_id FROM v_user_notices WHERE user_id = $1 AND NOT is_read
     ON CONFLICT DO NOTHING`, [userId]);
  return r.rowCount ?? 0;
}

/** Targets of several notices, keyed by notice id. */
export async function targetsOf(noticeIds: number[]): Promise<Map<number, NoticeTarget[]>> {
  const rows = noticeIds.length === 0 ? [] : await query<NoticeTarget & { notice_id: number }>(
    `SELECT t.notice_id, t.role::text AS role, t.dept_id, t.year_of_study, t.division_id, d.division_code
     FROM notice_target t LEFT JOIN division d ON d.division_id = t.division_id
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
