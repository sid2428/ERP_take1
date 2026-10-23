import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { HttpError, notFound } from '../lib/http-error.js';
import { PAGE_SIZE } from '../lib/pagination.js';

export const studentApiRouter = Router();

studentApiRouter.get('/attendance', async (req, res) => {
  const studentId = req.user!.studentId!;
  const rows = await query<{
    course_id: number;
    course_code: string;
    course_name: string;
    course_type: string;
    attended: number;
    total_sessions: number;
    attendance_pct: number | null;
  }>(`
    SELECT c.course_id, c.course_code, c.course_name, c.course_type,
           a.attended, a.total_sessions, a.attendance_pct
    FROM attendance_summary a
    JOIN course c USING (course_id)
    WHERE a.student_id = $1 AND a.academic_session_id = current_session_id()
    ORDER BY c.course_code`, [studentId]);

  const courses = rows.map((row) => ({
    ...row,
    below_75_percent: row.attendance_pct !== null && row.attendance_pct < 75,
  }));
  res.json({
    courses: {
      theory: courses.filter((course) => course.course_type !== 'LAB'),
      lab: courses.filter((course) => course.course_type === 'LAB'),
    },
  });
});

studentApiRouter.get('/attendance/:courseId', async (req, res) => {
  const studentId = req.user!.studentId!;
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId <= 0) throw notFound('Course');

  const pageValue = req.query.page ?? '1';
  const pageNumber = typeof pageValue === 'string' ? Number(pageValue) : NaN;
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new HttpError(400, 'Page must be a positive integer');
  }
  const page = Math.min(pageNumber, 10_000);
  const offset = (page - 1) * PAGE_SIZE;
  const ownedCourse = await queryOne<{ course_id: number }>(
    'SELECT course_id FROM attendance_summary WHERE student_id = $1 AND course_id = $2 LIMIT 1',
    [studentId, courseId]);
  if (!ownedCourse) throw notFound('Course attendance');

  const [count, records] = await Promise.all([
    queryOne<{ total: number }>(
      'SELECT count(*)::int AS total FROM v_attendance_record WHERE student_id = $1 AND course_id = $2',
      [studentId, courseId]),
    query<{
      session_id: number;
      academic_session_id: string;
      session_date: string;
      status: string;
    }>(`
      SELECT r.session_id, ta.academic_session_id, r.session_date, r.status
      FROM v_attendance_record r
      JOIN teaching_assignment ta USING (assignment_id)
      WHERE r.student_id = $1 AND r.course_id = $2
      ORDER BY r.session_date DESC, r.session_id DESC
      LIMIT $3 OFFSET $4`, [studentId, courseId, PAGE_SIZE, offset]),
  ]);
  const total = count?.total ?? 0;
  res.json({
    course_id: courseId,
    records,
    pagination: {
      page,
      page_size: PAGE_SIZE,
      total,
      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    },
  });
});

studentApiRouter.get('/exams', async (req, res) => {
  const studentId = req.user!.studentId!;
  const exams = await query<{
    exam_cycle_id: number;
    academic_session_id: string;
    exam_type: string;
    cycle_status: string;
    course_id: number;
    course_code: string;
    course_name: string;
    registration_status: string;
    exam_mode: string;
    exam_date: string;
    session: string;
    start_time: string;
    end_time: string;
    attendance_pct: number | null;
    hall_ticket_status: string | null;
    hall_ticket_no: string | null;
    hall_ticket_issued_on: string | null;
  }>(`
    SELECT cy.exam_cycle_id, cy.academic_session_id, cy.exam_type,
           cy.status AS cycle_status, c.course_id, c.course_code, c.course_name,
           reg.registration_status, sch.exam_mode, sch.exam_date, sch.session,
           sch.start_time, sch.end_time, a.attendance_pct,
           ht.status AS hall_ticket_status, ht.hall_ticket_no, ht.issued_on AS hall_ticket_issued_on
    FROM exam_registration reg
    JOIN exam_cycle cy USING (exam_cycle_id)
    JOIN course c USING (course_id)
    LEFT JOIN exam_schedule sch ON sch.exam_cycle_id = cy.exam_cycle_id AND sch.course_id = c.course_id
    LEFT JOIN attendance_summary a
      ON a.student_id = reg.student_id AND a.course_id = reg.course_id
     AND a.academic_session_id = cy.academic_session_id
    LEFT JOIN hall_ticket ht ON ht.student_id = reg.student_id AND ht.exam_cycle_id = cy.exam_cycle_id
    WHERE reg.student_id = $1 AND sch.schedule_id IS NOT NULL
    ORDER BY sch.exam_date NULLS LAST, cy.exam_cycle_id DESC, c.course_code, sch.start_time`,
  [studentId]);

  res.json({
    exams: exams.map((exam) => ({
      ...exam,
      attendance_eligible: exam.attendance_pct !== null && exam.attendance_pct >= 75,
      hall_ticket_eligible: exam.registration_status === 'Registered'
        && exam.attendance_pct !== null && exam.attendance_pct >= 75,
    })),
  });
});

studentApiRouter.get('/results', async (req, res) => {
  const studentId = req.user!.studentId!;
  const [marks, courseResults, semesterResults, cgpa] = await Promise.all([
    query<{
      marks_id: number;
      course_id: number;
      course_code: string;
      course_name: string;
      course_type: string;
      attempt_no: number;
      exam_cycle_id: number;
      exam_type: string;
      internal_marks: number | null;
      internal_max: number;
      midsem_marks: number | null;
      midsem_max: number;
      endsem_marks: number | null;
      endsem_max: number;
      endsem_status: string;
    }>(`
      SELECT m.marks_id, m.course_id, c.course_code, c.course_name, c.course_type, m.attempt_no,
             m.exam_cycle_id, cy.exam_type, m.internal_marks, m.midsem_marks,
             m.endsem_marks, m.endsem_status, sch.internal_max, sch.midsem_max, sch.endsem_max
      FROM exam_marks m
      JOIN course c USING (course_id)
      JOIN course_exam_scheme sch USING (course_id)
      JOIN exam_cycle cy USING (exam_cycle_id)
      WHERE m.student_id = $1
      ORDER BY cy.start_date DESC, c.course_code, m.attempt_no DESC`, [studentId]),
    query<{
      result_id: number;
      academic_session_id: string;
      semester: number;
      course_id: number;
      course_code: string;
      course_name: string;
      course_type: string;
      attempt_no: number;
      total_marks: number;
      max_marks: number;
      internal_marks: number | null;
      internal_max: number;
      midsem_marks: number | null;
      midsem_max: number;
      endsem_marks: number | null;
      endsem_max: number;
      percentage: number;
      grade: string;
      grade_points: number;
      result_status: string;
      is_final_attempt: boolean;
    }>(`
      SELECT r.result_id, r.academic_session_id, r.semester, r.course_id,
             c.course_type, m.internal_marks, sch.internal_max,
             m.midsem_marks, sch.midsem_max, m.endsem_marks, sch.endsem_max,
             c.course_code, c.course_name, r.attempt_no, r.total_marks, r.max_marks,
             r.percentage, r.grade, r.grade_points, r.result_status, r.is_final_attempt
      FROM course_result r
      JOIN course c USING (course_id)
      JOIN course_exam_scheme sch USING (course_id)
      LEFT JOIN exam_marks m
        ON m.student_id = r.student_id AND m.course_id = r.course_id AND m.attempt_no = r.attempt_no
      WHERE r.student_id = $1
      ORDER BY r.academic_session_id DESC, r.semester DESC, c.course_code, r.attempt_no`,
    [studentId]),
    query<{
      academic_session_id: string;
      semester: number;
      credits_registered: number;
      credits_earned: number;
      sgpa: number;
      backlogs: number;
      result_status: string;
    }>(`
      SELECT academic_session_id, semester, credits_registered, credits_earned,
             sgpa, backlogs, result_status
      FROM semester_result
      WHERE student_id = $1
      ORDER BY academic_session_id DESC, semester DESC`, [studentId]),
    queryOne<{
      semesters_completed: number;
      credits_attempted: number;
      credits_earned: number;
      cgpa: number;
      backlog_count: number;
    }>(`
      SELECT semesters_completed, credits_attempted, credits_earned,
             calculate_cgpa($1) AS cgpa, backlog_count
      FROM student_cgpa
      WHERE student_id = $1`, [studentId]),
  ]);

  res.json({ marks, course_results: courseResults, semester_results: semesterResults, cgpa: cgpa ?? null });
});
