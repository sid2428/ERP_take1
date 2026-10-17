import { query, queryOne } from '../db.js';

export interface FacultyProfile {
  faculty_id: number; faculty_code: string; first_name: string; last_name: string; gender: string; dept_id: string;
  dept_name: string; designation: string; qualification: string; date_of_joining: string; email: string;
  mobile_number: string; status: string; is_hod: boolean;
}

export function getFacultyProfile(facultyId: number): Promise<FacultyProfile | undefined> {
  return queryOne<FacultyProfile>(`
    SELECT f.*, d.dept_name, d.hod_faculty_id = f.faculty_id AS is_hod
    FROM faculty f JOIN department d USING (dept_id) WHERE f.faculty_id = $1`, [facultyId]);
}

export interface ClassRow {
  assignment_id: number; session_type: string; course_id: number; course_code: string; course_name: string;
  course_type: string; min_attendance_pct: number; class_label: string; batch_code: string | null; weekly_sessions: number;
  students: number; sessions_held: number; avg_pct: number | null; below_min: number; last_session: string | null;
}

/** A faculty member's teaching assignments this term, with attendance statistics. */
export function getFacultyClasses(facultyId: number): Promise<ClassRow[]> {
  return query<ClassRow>(`
    SELECT ta.assignment_id, ta.session_type, ta.weekly_sessions, c.course_id, c.course_code, c.course_name,
           c.course_type, c.min_attendance_pct,
           COALESCE(d.division_code, c.course_code || ' honors ' || o.section_name) AS class_label, b.batch_code,
           (SELECT count(*) FROM v_assignment_roster r WHERE r.assignment_id = ta.assignment_id)::int AS students,
           st.sessions_held, st.last_session, sm.avg_pct, sm.below_min
    FROM teaching_assignment ta
    JOIN course c USING (course_id)
    LEFT JOIN division d ON d.division_id = ta.division_id
    LEFT JOIN batch b ON b.batch_id = ta.batch_id
    LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
    LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE session_status = 'Conducted')::int AS sessions_held,
                              max(session_date) FILTER (WHERE session_status = 'Conducted') AS last_session
                       FROM attendance_session s WHERE s.assignment_id = ta.assignment_id) st ON true
    LEFT JOIN LATERAL (SELECT round(avg(attendance_pct), 1) AS avg_pct,
                              count(*) FILTER (WHERE attendance_pct < c.min_attendance_pct)::int AS below_min
                       FROM attendance_summary a WHERE a.assignment_id = ta.assignment_id) sm ON true
    WHERE ta.faculty_id = $1 AND ta.academic_session_id = current_session_id()
    ORDER BY c.course_code, class_label, b.batch_code`, [facultyId]);
}

export function getAssignment(assignmentId: number, facultyId: number): Promise<ClassRow | undefined> {
  return getFacultyClasses(facultyId).then((rows) => rows.find((r) => r.assignment_id === assignmentId));
}

export interface RosterRow {
  student_id: number; student_number: string; name: string; roll_no: number | null; batch_code: string | null;
  total_sessions: number | null; attended: number | null; attendance_pct: number | null; sessions_to_recover: number | null;
}

export function getRoster(assignmentId: number): Promise<RosterRow[]> {
  return query<RosterRow>(`
    SELECT s.student_id, s.student_number, s.first_name || ' ' || s.last_name AS name, ss.roll_no, b.batch_code,
           a.total_sessions, a.attended, a.attendance_pct, a.sessions_to_recover
    FROM v_assignment_roster r
    JOIN teaching_assignment ta USING (assignment_id)
    JOIN student s ON s.student_id = r.student_id
    LEFT JOIN student_section ss ON ss.student_id = s.student_id AND ss.academic_session_id = ta.academic_session_id
    LEFT JOIN batch b ON b.batch_id = ss.batch_id
    LEFT JOIN v_student_attendance_by_course a
           ON a.student_id = s.student_id AND a.course_id = ta.course_id AND a.academic_session_id = ta.academic_session_id
    WHERE r.assignment_id = $1
    ORDER BY ss.division_id, ss.roll_no, s.student_number`, [assignmentId]);
}

/** True if the student sits in any of this faculty member's classes this term. */
export async function teachesStudent(facultyId: number, studentId: number): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM teaching_assignment ta JOIN v_assignment_roster r USING (assignment_id)
                   WHERE ta.faculty_id = $1 AND r.student_id = $2 AND ta.academic_session_id = current_session_id()) AS ok`,
    [facultyId, studentId]);
  return row?.ok ?? false;
}
