/** Queries used by more than one role. */
import { query, queryOne } from '../db.js';

export interface StudentProfile {
  student_id: number; student_number: string; first_name: string; middle_name: string | null; last_name: string;
  date_of_birth: string; gender: string; blood_group: string | null; email: string; personal_email: string | null;
  mobile_number: string; alternate_mobile: string | null; category: string; nationality: string; status: string;
  admission_number: string; admission_date: string; admission_type: string; admission_year: number;
  program_id: string; program_name: string; total_semesters: number; total_credits_req: number;
  dept_id: string; dept_name: string; district_name: string | null; address: string | null; pincode: string | null;
  division_id: number | null; division_code: string | null; year_of_study: number | null; semester: number | null;
  batch_code: string | null; roll_no: number | null;
}

/** Full student record with program, department and current-term section. */
export function getStudentProfile(studentId: number): Promise<StudentProfile | undefined> {
  return queryOne<StudentProfile>(`
    SELECT s.*, p.program_name, p.total_semesters, p.total_credits_req, d.dept_id, d.dept_name,
           ss.division_id, dv.division_code, dv.year_of_study, dv.semester, b.batch_code, ss.roll_no
    FROM student s
    JOIN program p USING (program_id)
    JOIN department d ON d.dept_id = p.dept_id
    LEFT JOIN student_section ss ON ss.student_id = s.student_id AND ss.academic_session_id = current_session_id()
    LEFT JOIN division dv ON dv.division_id = ss.division_id
    LEFT JOIN batch b ON b.batch_id = ss.batch_id
    WHERE s.student_id = $1`, [studentId]);
}

export interface CourseAttendanceRow {
  course_id: number; course_code: string; course_name: string; course_type: string; credits: number;
  lecture_hrs: number; tutorial_hrs: number; practical_hrs: number; faculty_name: string | null;
  total_sessions: number | null; attended: number | null; attendance_pct: number | null;
  min_attendance_pct: number; eligibility: string | null; sessions_to_recover: number | null; is_honors: boolean;
}

/** A student's current-term courses with their teacher and attendance. */
export function getStudentCourses(studentId: number): Promise<CourseAttendanceRow[]> {
  return query<CourseAttendanceRow>(`
    SELECT c.course_id, c.course_code, c.course_name, c.course_type, c.credits,
           c.lecture_hrs, c.tutorial_hrs, c.practical_hrs, c.min_attendance_pct,
           f.first_name || ' ' || f.last_name AS faculty_name,
           a.total_sessions, a.attended, a.attendance_pct, a.eligibility, a.sessions_to_recover,
           e.offering_id IS NOT NULL AS is_honors
    FROM student_enrollment e
    JOIN course c USING (course_id)
    LEFT JOIN v_student_attendance_by_course a
           ON a.student_id = e.student_id AND a.course_id = e.course_id AND a.academic_session_id = e.academic_session_id
    LEFT JOIN teaching_assignment ta ON ta.assignment_id = a.assignment_id
    LEFT JOIN faculty f ON f.faculty_id = ta.faculty_id
    WHERE e.student_id = $1 AND e.academic_session_id = current_session_id() AND e.status = 'Enrolled'
    ORDER BY c.course_type, c.course_code`, [studentId]);
}

export interface TimetableRow {
  entry_id: number; day_of_week: number; start_period: number; periods: number; start_time: string; end_time: string;
  assignment_id: number; session_type: string; course_code: string; course_name: string; course_type: string;
  faculty_name: string; division_code: string | null; batch_code: string | null; offering_section: string | null; room_code: string;
}

export function getStudentTimetable(studentId: number): Promise<TimetableRow[]> {
  return query<TimetableRow>(`
    SELECT t.* FROM v_timetable t
    JOIN v_assignment_roster r ON r.assignment_id = t.assignment_id
    WHERE r.student_id = $1 AND t.academic_session_id = current_session_id()
    ORDER BY t.day_of_week, t.start_period`, [studentId]);
}

export function getFacultyTimetable(facultyId: number): Promise<TimetableRow[]> {
  return query<TimetableRow>(`
    SELECT * FROM v_timetable WHERE faculty_id = $1 AND academic_session_id = current_session_id()
    ORDER BY day_of_week, start_period`, [facultyId]);
}

export interface CurriculumRow {
  semester_no: number; course_category: string; elective_group: string | null; course_id: number; course_code: string;
  course_name: string; course_type: string; credits: number; course_home_dept: string; placement_kind: string;
  prerequisites: string | null;
}

export function getCurriculum(programId: string): Promise<CurriculumRow[]> {
  return query<CurriculumRow>(`
    SELECT v.semester_no, v.course_category, v.elective_group, v.course_id, v.course_code, v.course_name,
           v.course_type, v.credits, v.course_home_dept, v.placement_kind,
           (SELECT string_agg(pc.course_code, ', ' ORDER BY pc.course_code)
              FROM course_prerequisite p JOIN course pc ON pc.course_id = p.prereq_course_id
             WHERE p.course_id = v.course_id) AS prerequisites
    FROM v_curriculum v WHERE v.program_id = $1
    ORDER BY v.semester_no, v.course_category, v.course_code`, [programId]);
}

/** Pick the classes to show for "today": today's if it has any, else the next day that does. */
export function nextClassDay<T extends { day_of_week: number }>(rows: T[], todayWeekday: number): { offset: number; day: number; rows: T[] } | null {
  for (let offset = 0; offset < 7; offset++) {
    const day = ((todayWeekday - 1 + offset) % 7) + 1;
    const dayRows = rows.filter((r) => r.day_of_week === day);
    if (dayRows.length) return { offset, day, rows: dayRows };
  }
  return null;
}
