import { query, queryOne, type Db } from '../db.js';
import { HttpError, notFound } from '../lib/http-error.js';

export interface FacultyExamMarkEntry {
  student_id: number;
  internal_marks: number | null;
  midsem_marks: number | null;
  endsem_marks: number | null;
}

interface AssignedCourse {
  course_id: number;
  course_code: string;
  course_name: string;
  internal_max: number | null;
  midsem_max: number | null;
  endsem_max: number | null;
  total_max: number | null;
  passing_percentage: number | null;
  roster_size: number;
  exam_cycle_id: number | null;
  exam_type: string | null;
  marks_entered: number;
  average_total: number | null;
}

export function getFacultyExamCourses(facultyId: number): Promise<AssignedCourse[]> {
  return query<AssignedCourse>(`
    WITH assigned AS (
      SELECT DISTINCT course_id
      FROM teaching_assignment
      WHERE faculty_id = $1 AND academic_session_id = current_session_id()
    ), roster_members AS (
      SELECT DISTINCT ac.course_id, r.student_id
      FROM assigned ac
      JOIN teaching_assignment ta ON ta.course_id = ac.course_id
        AND ta.faculty_id = $1 AND ta.academic_session_id = current_session_id()
      LEFT JOIN v_assignment_roster r USING (assignment_id)
    ), roster AS (
      SELECT course_id, count(student_id)::int AS roster_size
      FROM roster_members
      GROUP BY course_id
    )
    SELECT c.course_id, c.course_code, c.course_name,
           sch.internal_max, sch.midsem_max, sch.endsem_max, sch.total_max, sch.passing_percentage,
           roster.roster_size, cy.exam_cycle_id, cy.exam_type,
           COALESCE(mark_summary.marks_entered, 0)::int AS marks_entered,
           mark_summary.average_total
    FROM assigned ac
    JOIN course c USING (course_id)
    JOIN roster USING (course_id)
    LEFT JOIN course_exam_scheme sch USING (course_id)
    LEFT JOIN LATERAL (
      SELECT ec.exam_cycle_id, ec.exam_type
      FROM exam_cycle ec
      WHERE ec.academic_session_id = current_session_id() AND ec.status <> 'Completed'
      ORDER BY ec.start_date DESC, ec.exam_cycle_id DESC
      LIMIT 1
    ) cy ON true
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (
               WHERE m.internal_marks IS NOT NULL OR m.midsem_marks IS NOT NULL OR m.endsem_marks IS NOT NULL
             )::int AS marks_entered,
             avg(COALESCE(m.internal_marks, 0) + COALESCE(m.midsem_marks, 0)
               + COALESCE(m.endsem_marks, 0)) FILTER (
                 WHERE m.internal_marks IS NOT NULL OR m.midsem_marks IS NOT NULL OR m.endsem_marks IS NOT NULL
               ) AS average_total
      FROM roster_members rm
      LEFT JOIN LATERAL (
        SELECT marks.internal_marks, marks.midsem_marks, marks.endsem_marks
        FROM exam_marks marks
        WHERE marks.student_id = rm.student_id
          AND marks.course_id = ac.course_id AND marks.exam_cycle_id = cy.exam_cycle_id
        ORDER BY marks.attempt_no DESC
        LIMIT 1
      ) m ON true
      WHERE rm.course_id = ac.course_id AND rm.student_id IS NOT NULL
    ) mark_summary ON true
    ORDER BY c.course_code`, [facultyId]);
}

export async function getFacultyExamCourse(facultyId: number, courseId: number, cycleId?: number) {
  const course = await queryOne<{
    course_id: number;
    course_code: string;
    course_name: string;
    internal_max: number | null;
    midsem_max: number | null;
    endsem_max: number | null;
    total_max: number | null;
    passing_percentage: number | null;
  }>(`
    SELECT c.course_id, c.course_code, c.course_name,
           sch.internal_max, sch.midsem_max, sch.endsem_max, sch.total_max, sch.passing_percentage
    FROM course c
    JOIN teaching_assignment ta USING (course_id)
    LEFT JOIN course_exam_scheme sch USING (course_id)
    WHERE c.course_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()
    LIMIT 1`, [courseId, facultyId]);
  if (!course) throw notFound('Assigned course');

  const cycles = await query<{
    exam_cycle_id: number;
    exam_type: string;
    status: string;
    start_date: string;
    end_date: string;
  }>(`
    SELECT exam_cycle_id, exam_type, status, start_date, end_date
    FROM exam_cycle
    WHERE academic_session_id = current_session_id() AND status <> 'Completed'
    ORDER BY start_date DESC, exam_cycle_id DESC`);
  const selectedCycle = cycleId === undefined
    ? cycles[0]
    : cycles.find((cycle) => cycle.exam_cycle_id === cycleId);
  if (cycleId !== undefined && !selectedCycle) {
    throw new HttpError(400, 'Choose an examination cycle in the current session that is open for marks entry.');
  }

  const students = await query<{
    student_id: number;
    student_number: string;
    name: string;
    roll_no: number | null;
    internal_marks: number | null;
    midsem_marks: number | null;
    endsem_marks: number | null;
    endsem_status: string | null;
    attempt_no: number | null;
  }>(`
    WITH roster AS (
      SELECT DISTINCT r.student_id
      FROM teaching_assignment ta
      JOIN v_assignment_roster r USING (assignment_id)
      WHERE ta.course_id = $1 AND ta.faculty_id = $2
        AND ta.academic_session_id = current_session_id()
    )
    SELECT s.student_id, s.student_number, s.first_name || ' ' || s.last_name AS name,
           ss.roll_no, m.internal_marks, m.midsem_marks, m.endsem_marks, m.endsem_status, m.attempt_no
    FROM roster r
    JOIN student s USING (student_id)
    LEFT JOIN student_section ss
      ON ss.student_id = s.student_id AND ss.academic_session_id = current_session_id()
    LEFT JOIN LATERAL (
      SELECT marks.internal_marks, marks.midsem_marks, marks.endsem_marks,
             marks.endsem_status, marks.attempt_no
      FROM exam_marks marks
      WHERE marks.student_id = s.student_id AND marks.course_id = $1 AND marks.exam_cycle_id = $3
      ORDER BY marks.attempt_no DESC
      LIMIT 1
    ) m ON true
    ORDER BY ss.roll_no NULLS LAST, s.student_number`,
  [courseId, facultyId, selectedCycle?.exam_cycle_id ?? null]);

  const markedStudents = students.filter((student) =>
    student.internal_marks !== null || student.midsem_marks !== null || student.endsem_marks !== null);
  const averageTotal = markedStudents.length
    ? markedStudents.reduce((total, student) =>
      total + (student.internal_marks ?? 0) + (student.midsem_marks ?? 0) + (student.endsem_marks ?? 0), 0)
      / markedStudents.length
    : null;

  return {
    course,
    cycles,
    selected_cycle: selectedCycle ?? null,
    students,
    summary: {
      roster_size: students.length,
      marks_entered: markedStudents.length,
      average_total: averageTotal,
      average_percentage: averageTotal !== null && course.total_max
        ? averageTotal / course.total_max * 100
        : null,
    },
  };
}

export async function saveFacultyExamMarks(
  db: Db,
  facultyId: number,
  courseId: number,
  cycleId: number,
  entries: FacultyExamMarkEntry[],
): Promise<{ saved: number; course_results_updated: number }> {
  await db.query('SELECT pg_advisory_xact_lock($1::integer, $2::integer)', [courseId, cycleId]);

  const scope = await queryOne<{
    academic_session_id: string;
    semester_no: number;
    internal_max: number | null;
    midsem_max: number | null;
    endsem_max: number | null;
    total_max: number | null;
    passing_percentage: number | null;
  }>(`
    SELECT ta.academic_session_id,
           COALESCE(
             (SELECT d.semester
              FROM teaching_assignment section_ta
              JOIN division d USING (division_id)
              WHERE section_ta.course_id = ta.course_id
                AND section_ta.faculty_id = $2
                AND section_ta.academic_session_id = ta.academic_session_id
              ORDER BY section_ta.assignment_id
              LIMIT 1),
             (SELECT min(d.semester)
              FROM teaching_assignment offering_ta
              JOIN v_assignment_roster r USING (assignment_id)
              JOIN student_section ss
                ON ss.student_id = r.student_id
               AND ss.academic_session_id = offering_ta.academic_session_id
              JOIN division d
                ON d.division_id = ss.division_id
               AND d.academic_session_id = ss.academic_session_id
              WHERE offering_ta.course_id = ta.course_id
                AND offering_ta.faculty_id = $2
                AND offering_ta.academic_session_id = ta.academic_session_id),
             (SELECT min(pc.semester_no) FROM program_curriculum pc WHERE pc.course_id = ta.course_id),
             1
           )::smallint AS semester_no,
           sch.internal_max, sch.midsem_max, sch.endsem_max, sch.total_max, sch.passing_percentage
    FROM teaching_assignment ta
    JOIN course c USING (course_id)
    LEFT JOIN course_exam_scheme sch USING (course_id)
    WHERE ta.course_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()`, [courseId, facultyId], db);
  if (!scope) throw notFound('Assigned course');
  if (scope.total_max === null) throw new HttpError(400, 'This course has no examination scheme.');

  const cycle = await queryOne<{ exam_cycle_id: number }>(`
    SELECT exam_cycle_id
    FROM exam_cycle
    WHERE exam_cycle_id = $1 AND academic_session_id = $2 AND status <> 'Completed'`,
  [cycleId, scope.academic_session_id], db);
  if (!cycle) throw new HttpError(400, 'Choose an examination cycle in the current session that is open for marks entry.');

  const roster = await query<{ student_id: number }>(`
    SELECT DISTINCT r.student_id
    FROM teaching_assignment ta
    JOIN v_assignment_roster r USING (assignment_id)
    WHERE ta.course_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = $3`,
  [courseId, facultyId, scope.academic_session_id], db);
  const rosterIds = new Set(roster.map((student) => student.student_id));
  if (entries.some((entry) => !rosterIds.has(entry.student_id))) {
    throw new HttpError(400, 'A student is not on your assigned course roster.');
  }

  for (const entry of entries) {
    const values = [entry.internal_marks, entry.midsem_marks, entry.endsem_marks];
    const maxima = [scope.internal_max, scope.midsem_max, scope.endsem_max];
    if (values.some((value, index) => value !== null && (maxima[index] === null || value > maxima[index]!))) {
      throw new HttpError(400, 'Marks cannot be negative or exceed the course examination scheme maximum.');
    }
  }

  const existing = await query<{ student_id: number }>(`
    SELECT DISTINCT m.student_id
    FROM exam_marks m
    WHERE m.course_id = $1 AND m.exam_cycle_id = $2 AND m.student_id = ANY($3::int[])`,
  [courseId, cycleId, entries.map((entry) => entry.student_id)], db);
  const existingIds = new Set(existing.map((row) => row.student_id));
  const toSave = entries.filter((entry) => existingIds.has(entry.student_id)
    || entry.internal_marks !== null || entry.midsem_marks !== null || entry.endsem_marks !== null);
  if (!toSave.length) return { saved: 0, course_results_updated: 0 };

  const savedMarks = await query<{
    student_id: number;
    attempt_no: number;
    internal_marks: number | null;
    midsem_marks: number | null;
    endsem_marks: number | null;
  }>(`
    INSERT INTO exam_marks (
      student_id, course_id, attempt_no, exam_cycle_id,
      internal_marks, midsem_marks, endsem_marks, endsem_status, entered_by, last_updated
    )
    SELECT i.student_id, $2,
           COALESCE(current_mark.attempt_no, history.next_attempt),
           $3, i.internal_marks, i.midsem_marks, i.endsem_marks,
           CASE WHEN i.endsem_marks IS NULL THEN 'Pending'::exam_mark_state
                ELSE 'Present'::exam_mark_state END,
           $4, now()
    FROM json_to_recordset($1::json) AS i(
      student_id int, internal_marks numeric, midsem_marks numeric, endsem_marks numeric
    )
    LEFT JOIN LATERAL (
      SELECT marks.attempt_no
      FROM exam_marks marks
      WHERE marks.student_id = i.student_id AND marks.course_id = $2 AND marks.exam_cycle_id = $3
      ORDER BY marks.attempt_no DESC
      LIMIT 1
    ) current_mark ON true
    LEFT JOIN LATERAL (
      SELECT GREATEST(
        COALESCE((SELECT max(attempt_no) FROM exam_marks
                  WHERE student_id = i.student_id AND course_id = $2), 0),
        COALESCE((SELECT max(attempt_no) FROM course_result
                  WHERE student_id = i.student_id AND course_id = $2), 0)
      ) + 1 AS next_attempt
    ) history ON true
    ON CONFLICT (student_id, course_id, attempt_no) DO UPDATE
      SET exam_cycle_id = EXCLUDED.exam_cycle_id,
          internal_marks = EXCLUDED.internal_marks,
          midsem_marks = EXCLUDED.midsem_marks,
          endsem_marks = EXCLUDED.endsem_marks,
          endsem_status = EXCLUDED.endsem_status,
          entered_by = EXCLUDED.entered_by,
          last_updated = EXCLUDED.last_updated
    RETURNING student_id, attempt_no, internal_marks, midsem_marks, endsem_marks`,
  [JSON.stringify(toSave), courseId, cycleId, facultyId], db);

  const resultRows = JSON.stringify(savedMarks.map((mark) => ({
    student_id: mark.student_id,
    attempt_no: mark.attempt_no,
    internal_marks: mark.internal_marks,
    midsem_marks: mark.midsem_marks,
    endsem_marks: mark.endsem_marks,
  })));
  await db.query(`
    UPDATE course_result r
    SET is_final_attempt = false
    FROM json_to_recordset($1::json) AS i(student_id int, attempt_no smallint)
    WHERE r.student_id = i.student_id AND r.course_id = $2
      AND r.is_final_attempt AND r.attempt_no <> i.attempt_no`,
  [resultRows, courseId]);

  const results = await query<{ result_id: number }>(`
    WITH scored AS (
      SELECT i.student_id, i.attempt_no,
             round(COALESCE(i.internal_marks, 0) + COALESCE(i.midsem_marks, 0)
               + COALESCE(i.endsem_marks, 0))::smallint AS total_marks
      FROM json_to_recordset($1::json) AS i(
        student_id int, attempt_no smallint, internal_marks numeric, midsem_marks numeric, endsem_marks numeric
      )
    ), graded AS (
      SELECT s.student_id, s.attempt_no, s.total_marks,
             round(s.total_marks::numeric * 100 / $4, 2) AS percentage,
             g.grade, g.grade_points
      FROM scored s
      JOIN LATERAL (
        SELECT grade, grade_points
        FROM grade_scale
        WHERE round(s.total_marks::numeric * 100 / $4, 2) BETWEEN min_percentage AND max_percentage
        ORDER BY min_percentage DESC
        LIMIT 1
      ) g ON true
    )
    INSERT INTO course_result (
      student_id, course_id, academic_session_id, semester, attempt_no,
      total_marks, max_marks, percentage, grade, grade_points, result_status, is_final_attempt
    )
    SELECT g.student_id, $2, $3, $5, g.attempt_no, g.total_marks, $4, g.percentage,
           g.grade, g.grade_points,
           CASE WHEN g.percentage >= $6 THEN 'Pass'::exam_result_state ELSE 'Fail'::exam_result_state END,
           true
    FROM graded g
    ON CONFLICT (student_id, course_id, attempt_no) DO UPDATE
      SET academic_session_id = EXCLUDED.academic_session_id,
          semester = EXCLUDED.semester,
          total_marks = EXCLUDED.total_marks,
          max_marks = EXCLUDED.max_marks,
          percentage = EXCLUDED.percentage,
          grade = EXCLUDED.grade,
          grade_points = EXCLUDED.grade_points,
          result_status = EXCLUDED.result_status,
          is_final_attempt = true
    RETURNING result_id`,
  [resultRows, courseId, scope.academic_session_id, scope.total_max, scope.semester_no,
    scope.passing_percentage ?? 40], db);
  if (results.length !== savedMarks.length) {
    throw new HttpError(400, 'The configured grade scale does not cover one or more saved marks percentages.');
  }

  return { saved: savedMarks.length, course_results_updated: results.length };
}
