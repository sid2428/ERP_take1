/** Grievance queries (T8-2). The workflow rules live in migrations/080-grievances.sql. */
import type pg from 'pg';
import { query, queryOne, type Db } from '../db.js';

export const GRIEVANCE_CATEGORIES = ['Academic', 'Attendance', 'Fees', 'Exam', 'Facilities', 'Other'] as const;
export const GRIEVANCE_STATUSES = ['Open', 'In progress', 'Resolved', 'Rejected'] as const;
export type GrievanceStatus = (typeof GRIEVANCE_STATUSES)[number];

export interface GrievanceRow {
  grievance_id: number;
  category: string;
  subject: string;
  description: string;
  status: GrievanceStatus;
  raised_by: number;
  raised_by_role: 'student' | 'faculty';
  raised_by_login: string;
  raised_by_name: string;
  raised_by_dept: string | null;
  assigned_to: number | null;
  assigned_at: Date | null;
  assigned_code: string | null;
  assigned_name: string | null;
  assigned_user_id: number | null;
  resolution_note: string | null;
  resolved_by: number | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
  comment_count: number;
  age_days: number;
}

/** One entry of the trail on the detail page: a comment or a status change, in time order. */
export interface ThreadEntry {
  kind: 'comment' | 'status';
  at: Date;
  author_name: string | null;
  author_role: string | null;
  body: string | null;
  from_status: GrievanceStatus | null;
  to_status: GrievanceStatus | null;
}

/** Tell the database triggers who is acting, for the rest of this transaction. */
export async function actAs(db: pg.PoolClient, userId: number): Promise<void> {
  await db.query(`SELECT set_config('erp.user_id', $1, true)`, [String(userId)]);
}

export function listRaisedBy(userId: number): Promise<GrievanceRow[]> {
  return query<GrievanceRow>('SELECT * FROM v_grievance_overview WHERE raised_by = $1 ORDER BY created_at DESC', [userId]);
}

export function listAssignedTo(facultyId: number): Promise<GrievanceRow[]> {
  return query<GrievanceRow>(
    `SELECT * FROM v_grievance_overview WHERE assigned_to = $1
     ORDER BY (status IN ('Resolved', 'Rejected')), updated_at DESC`, [facultyId]);
}

/** The grievance if this account may see it (raiser, assignee or admin), otherwise undefined. */
export function getGrievanceFor(userId: number, grievanceId: number): Promise<GrievanceRow | undefined> {
  return queryOne<GrievanceRow>(
    'SELECT * FROM v_grievance_overview WHERE grievance_id = $2 AND grievance_participant($1, $2)', [userId, grievanceId]);
}

export function getThread(grievanceId: number): Promise<ThreadEntry[]> {
  return query<ThreadEntry>(`
    SELECT 'comment' AS kind, c.created_at AS at, p.display_name AS author_name, p.role::text AS author_role,
           c.body, NULL::grievance_status AS from_status, NULL::grievance_status AS to_status, c.comment_id AS seq
    FROM grievance_comment c JOIN v_user_profile p ON p.user_id = c.author_id
    WHERE c.grievance_id = $1
    UNION ALL
    SELECT 'status', l.changed_at, p.display_name, p.role::text, NULL, l.from_status, l.to_status, l.log_id
    FROM grievance_status_log l LEFT JOIN v_user_profile p ON p.user_id = l.changed_by
    WHERE l.grievance_id = $1 AND l.from_status IS NOT NULL
    ORDER BY at, kind DESC, seq`, [grievanceId]);
}

export async function insertComment(db: Db, grievanceId: number, authorId: number, body: string): Promise<void> {
  await db.query('INSERT INTO grievance_comment (grievance_id, author_id, body) VALUES ($1, $2, $3)', [grievanceId, authorId, body]);
}

/** CSS pill variant for a status (see public/css/app.css). */
export function statusPill(status: GrievanceStatus): string {
  return { Open: 'o', 'In progress': '', Resolved: 'g', Rejected: 'r' }[status];
}
