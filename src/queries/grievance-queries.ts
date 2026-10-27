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
  course_id: number | null;
  course_code: string | null;
  course_name: string | null;
  assigned_dept: string | null;
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
  /** closing note, or the admin's reason for an unlock */
  note: string | null;
}

/** One of the student's teachers for one course this term (lectures first). */
export interface CourseTeacher {
  course_id: number;
  course_code: string;
  course_name: string;
  faculty_id: number;
  faculty_name: string;
  session_type: string;
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
           c.body, NULL::grievance_status AS from_status, NULL::grievance_status AS to_status, NULL::text AS note,
           c.comment_id AS seq
    FROM grievance_comment c JOIN v_user_profile p ON p.user_id = c.author_id
    WHERE c.grievance_id = $1
    UNION ALL
    SELECT 'status', l.changed_at, p.display_name, p.role::text, NULL, l.from_status, l.to_status, l.note, l.log_id
    FROM grievance_status_log l LEFT JOIN v_user_profile p ON p.user_id = l.changed_by
    WHERE l.grievance_id = $1 AND l.from_status IS NOT NULL
    ORDER BY at, kind DESC, seq`, [grievanceId]);
}

/** Who teaches this student each of their courses this term; a course grievance goes to one of them. */
export function getCourseTeachers(studentId: number): Promise<CourseTeacher[]> {
  return query<CourseTeacher>(`
    SELECT DISTINCT ON (c.course_id, f.faculty_id) c.course_id, c.course_code, c.course_name, f.faculty_id,
           f.first_name || ' ' || f.last_name AS faculty_name, ta.session_type::text AS session_type
    FROM v_assignment_roster r
    JOIN teaching_assignment ta USING (assignment_id)
    JOIN course c ON c.course_id = ta.course_id
    JOIN faculty f ON f.faculty_id = ta.faculty_id AND f.status = 'Active'
    JOIN app_user fu ON fu.faculty_id = f.faculty_id AND fu.is_active      -- the teacher must be able to sign in (098)
    WHERE r.student_id = $1 AND ta.academic_session_id = current_session_id()
    ORDER BY c.course_id, f.faculty_id, ta.session_type`, [studentId])
    // lectures first within a course, so the first teacher listed is the default
    .then((rows) => rows.sort((a, b) => (a.course_code ?? '').localeCompare(b.course_code ?? '')
      || Number(a.session_type !== 'Lecture') - Number(b.session_type !== 'Lecture')
      || (a.faculty_name ?? '').localeCompare(b.faculty_name ?? '')));
}

export const isClosed = (status: GrievanceStatus): boolean => status === 'Resolved' || status === 'Rejected';

export async function insertComment(db: Db, grievanceId: number, authorId: number, body: string): Promise<void> {
  await db.query('INSERT INTO grievance_comment (grievance_id, author_id, body) VALUES ($1, $2, $3)', [grievanceId, authorId, body]);
}

/** CSS pill variant for a status (see public/css/app.css). */
export function statusPill(status: GrievanceStatus): string {
  return { Open: 'o', 'In progress': '', Resolved: 'g', Rejected: 'r' }[status];
}
