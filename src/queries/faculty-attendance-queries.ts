import { query, queryOne, type Db } from '../db.js';
import { HttpError, notFound } from '../lib/http-error.js';

export interface FacultyAttendanceAssignment {
  assignment_id: number;
  course_id: number;
  course_code: string;
  course_name: string;
  session_type: string;
  division_id: number | null;
  division_code: string | null;
  batch_id: number | null;
  batch_code: string | null;
  class_label: string;
  students: number;
  term_start: string;
  term_end: string;
}

export function getFacultyAttendanceAssignments(facultyId: number): Promise<FacultyAttendanceAssignment[]> {
  return query<FacultyAttendanceAssignment>(`
    SELECT ta.assignment_id, c.course_id, c.course_code, c.course_name, ta.session_type,
           d.division_id, d.division_code, b.batch_id, b.batch_code,
           COALESCE(d.division_code, o.section_name, c.course_code || ' offering') AS class_label,
           (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = ta.assignment_id) AS students,
           s.start_date AS term_start, s.end_date AS term_end
    FROM teaching_assignment ta
    JOIN academic_session s ON s.session_id = ta.academic_session_id
    JOIN course c USING (course_id)
    LEFT JOIN division d ON d.division_id = ta.division_id
    LEFT JOIN batch b ON b.batch_id = ta.batch_id
    LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
    WHERE ta.faculty_id = $1 AND ta.academic_session_id = current_session_id()
    ORDER BY c.course_code, class_label, b.batch_code`, [facultyId]);
}

export async function getFacultyAttendanceRoster(
  facultyId: number, assignmentId: number, date: string,
): Promise<{
  assignment: FacultyAttendanceAssignment;
  session_id: number | null;
  students: Array<{ student_id: number; student_number: string; name: string; roll_no: number | null; batch_code: string | null; status: string }>;
}> {
  const assignment = await queryOne<FacultyAttendanceAssignment>(`
    SELECT ta.assignment_id, c.course_id, c.course_code, c.course_name, ta.session_type,
           d.division_id, d.division_code, b.batch_id, b.batch_code,
           COALESCE(d.division_code, o.section_name, c.course_code || ' offering') AS class_label,
           (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = ta.assignment_id) AS students,
           s.start_date AS term_start, s.end_date AS term_end
    FROM teaching_assignment ta
    JOIN academic_session s ON s.session_id = ta.academic_session_id
    JOIN course c USING (course_id)
    LEFT JOIN division d ON d.division_id = ta.division_id
    LEFT JOIN batch b ON b.batch_id = ta.batch_id
    LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
    WHERE ta.assignment_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()`, [assignmentId, facultyId]);
  if (!assignment) throw notFound('Teaching assignment');
  if (date < assignment.term_start || date > assignment.term_end) {
    throw new HttpError(400, 'Attendance date must be within the academic session.');
  }

  const session = await queryOne<{ session_id: number; absent_student_ids: number[] }>(`
    SELECT session_id, absent_student_ids FROM attendance_session
    WHERE assignment_id = $1 AND session_date = $2 AND session_status = 'Conducted'`,
  [assignmentId, date]);
  const students = await query<{
    student_id: number;
    student_number: string;
    name: string;
    roll_no: number | null;
    batch_code: string | null;
    status: string;
  }>(`
    SELECT s.student_id, s.student_number, s.first_name || ' ' || s.last_name AS name,
           ss.roll_no, b.batch_code,
           CASE WHEN $2::int[] @> ARRAY[s.student_id] THEN 'A' ELSE 'P' END AS status
    FROM v_assignment_roster r
    JOIN student s USING (student_id)
    JOIN teaching_assignment ta USING (assignment_id)
    LEFT JOIN student_section ss
      ON ss.student_id = s.student_id AND ss.academic_session_id = ta.academic_session_id
    LEFT JOIN batch b ON b.batch_id = ss.batch_id
    WHERE r.assignment_id = $1
    ORDER BY ss.roll_no NULLS LAST, s.student_number`,
  [assignmentId, session?.absent_student_ids ?? []]);

  return { assignment, session_id: session?.session_id ?? null, students };
}

export function getFacultyAttendanceSessions(facultyId: number, assignmentId: number) {
  return query<{
    session_id: number;
    session_date: string;
    session_number: number;
    session_status: string;
    present_count: number;
    absent_count: number;
    marked_at: string | null;
  }>(`
    SELECT s.session_id, s.session_date, s.session_number, s.session_status,
           (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = s.assignment_id)
             - cardinality(s.absent_student_ids) AS present_count,
           cardinality(s.absent_student_ids) AS absent_count, s.marked_at
    FROM attendance_session s
    JOIN teaching_assignment ta USING (assignment_id)
    WHERE ta.assignment_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()
    ORDER BY s.session_date DESC, s.session_id DESC`, [assignmentId, facultyId]);
}

export async function saveFacultyAttendance(
  db: Db,
  facultyId: number,
  assignmentId: number,
  date: string,
  absentStudentIds: number[],
): Promise<{ session_id: number; session_number: number; created: boolean }> {
  await db.query('SELECT pg_advisory_xact_lock($1::integer)', [assignmentId]);
  const assignment = await queryOne<{ session_type: string; term_start: string; term_end: string }>(`
    SELECT ta.session_type, s.start_date AS term_start, s.end_date AS term_end
    FROM teaching_assignment ta
    JOIN academic_session s ON s.session_id = ta.academic_session_id
    WHERE ta.assignment_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()`, [assignmentId, facultyId], db);
  if (!assignment) throw notFound('Teaching assignment');
  if (date < assignment.term_start || date > assignment.term_end) {
    throw new HttpError(400, 'Attendance date must be within the academic session.');
  }

  const roster = await query<{ student_id: number }>(
    'SELECT student_id FROM v_assignment_roster WHERE assignment_id = $1', [assignmentId], db);
  const rosterIds = new Set(roster.map((row) => row.student_id));
  const invalidId = absentStudentIds.find((studentId) => !rosterIds.has(studentId));
  if (invalidId !== undefined) throw new HttpError(400, 'An absent student is not on this class roster.');

  const existing = await queryOne<{ session_id: number; session_number: number }>(`
    SELECT session_id, session_number FROM attendance_session
    WHERE assignment_id = $1 AND session_date = $2 FOR UPDATE`, [assignmentId, date], db);
  const nextNumber = existing?.session_number ?? (await queryOne<{ n: number }>(`
    SELECT COALESCE(max(session_number), 0)::int + 1 AS n
    FROM attendance_session WHERE assignment_id = $1`, [assignmentId], db))!.n;
  const duration = assignment.session_type === 'Lab' ? 2 : 1;
  const saved = await queryOne<{ session_id: number; session_number: number }>(`
    INSERT INTO attendance_session
      (assignment_id, session_date, session_number, duration_hrs, session_status,
       absent_student_ids, marked_by, marked_at)
    VALUES ($1, $2, $3, $4, 'Conducted', $5, $6, now())
    ON CONFLICT (assignment_id, session_date) DO UPDATE
      SET session_status = 'Conducted', absent_student_ids = EXCLUDED.absent_student_ids,
          marked_by = EXCLUDED.marked_by, marked_at = EXCLUDED.marked_at
    RETURNING session_id, session_number`,
  [assignmentId, date, nextNumber, duration, absentStudentIds, facultyId], db);
  if (!saved) throw new Error('Attendance save did not return the saved session.');
  return { ...saved, created: existing === undefined };
}
