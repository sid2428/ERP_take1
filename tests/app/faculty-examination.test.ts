import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };
const { saveFacultyExamMarks } = hasAppEnv
  ? await import('../../src/queries/faculty-examination-queries.js')
  : { saveFacultyExamMarks: null };

describe.skipIf(!hasAppEnv)('faculty examination', () => {
  const app = createApp!();
  const db = pool!;
  let faculty: Awaited<ReturnType<typeof signIn>>['agent'];
  let facultyId = 0;

  beforeAll(async () => {
    const login = await signIn(app, 'FAC-CSE-074', DEMO);
    expect(login.res.status).toBe(302);
    faculty = login.agent;
    const result = await db.query<{ faculty_id: number }>(
      `SELECT faculty_id FROM faculty WHERE faculty_code = 'FAC-CSE-074'`);
    facultyId = result.rows[0]!.faculty_id;
  });

  afterAll(async () => {
    await db.end();
  });

  it('serves the faculty examination page and only assigned courses', async () => {
    const anonymous = await request(app).get('/faculty/examination');
    expect(anonymous.status).toBe(302);

    const page = await faculty.get('/faculty/examination');
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-faculty-examination');
    expect(page.text).toContain('/static/js/faculty-examination.js');

    const response = await faculty.get('/faculty/examination/courses').set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body.courses.length).toBeGreaterThan(0);

    const other = await db.query<{ course_id: number }>(`
      SELECT DISTINCT ta.course_id
      FROM teaching_assignment ta
      WHERE ta.faculty_id <> $1 AND ta.academic_session_id = current_session_id()
        AND NOT EXISTS (
          SELECT 1 FROM teaching_assignment own
          WHERE own.course_id = ta.course_id AND own.faculty_id = $1
            AND own.academic_session_id = ta.academic_session_id
        )
      ORDER BY ta.course_id LIMIT 1`, [facultyId]);
    if (other.rows[0]) {
      const forbidden = await faculty.get(`/faculty/examination/courses/${other.rows[0].course_id}`)
        .set('Accept', 'application/json');
      expect(forbidden.status).toBe(404);

      const ownCourse = response.body.courses.find((item: { exam_cycle_id: number | null }) =>
        item.exam_cycle_id !== null);
      if (ownCourse) {
        const ownRoster = await faculty.get(`/faculty/examination/courses/${ownCourse.course_id}`)
          .set('Accept', 'application/json');
        const student = ownRoster.body.students[0];
        expect(student).toBeDefined();
        const forbiddenSave = await postForm(faculty, '/faculty/examination',
          `/faculty/examination/courses/${other.rows[0].course_id}/marks`, {
            exam_cycle_id: String(ownCourse.exam_cycle_id),
            entries_json: JSON.stringify([{
              student_id: student.student_id,
              internal_marks: null,
              midsem_marks: null,
              endsem_marks: null,
            }]),
          });
        expect(forbiddenSave.status).toBe(404);
      }
    }
  });

  it('validates scheme maxima and updates marks and course results transactionally', async () => {
    const response = await faculty.get('/faculty/examination/courses').set('Accept', 'application/json');
    const course = response.body.courses.find((item: {
      roster_size: number;
      exam_cycle_id: number | null;
      total_max: number | null;
      course_type: string;
    }) => item.roster_size > 0 && item.exam_cycle_id !== null
      && item.total_max === 100 && item.course_type === 'TH');
    expect(course).toBeDefined();

    const detail = await faculty.get(
      `/faculty/examination/courses/${course.course_id}?exam_cycle_id=${course.exam_cycle_id}`,
    ).set('Accept', 'application/json');
    expect(detail.status).toBe(200);
    const student = detail.body.students[0] as { student_id: number };
    expect(student).toBeDefined();

    const rejected = await postForm(faculty, '/faculty/examination',
      `/faculty/examination/courses/${course.course_id}/marks`, {
        exam_cycle_id: String(course.exam_cycle_id),
        entries_json: JSON.stringify([{
          student_id: student.student_id,
          internal_marks: course.internal_max + 1,
          midsem_marks: null,
          endsem_marks: null,
        }]),
      });
    expect(rejected.status).toBe(400);
    const negative = await postForm(faculty, '/faculty/examination',
      `/faculty/examination/courses/${course.course_id}/marks`, {
        exam_cycle_id: String(course.exam_cycle_id),
        entries_json: JSON.stringify([{
          student_id: student.student_id,
          internal_marks: -0.1,
          midsem_marks: null,
          endsem_marks: null,
        }]),
      });
    expect(negative.status).toBe(400);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = erp, public');
      const saved = await saveFacultyExamMarks!(client, facultyId, course.course_id, course.exam_cycle_id, [{
        student_id: student.student_id,
        internal_marks: 15,
        midsem_marks: 18,
        endsem_marks: 55,
      }]);
      expect(saved).toEqual({ saved: 1, course_results_updated: 1 });

      const marks = await client.query<{ internal_marks: number; midsem_marks: number; endsem_marks: number }>(`
        SELECT internal_marks::float8 AS internal_marks, midsem_marks::float8 AS midsem_marks,
               endsem_marks::float8 AS endsem_marks
        FROM exam_marks
        WHERE student_id = $1 AND course_id = $2 AND exam_cycle_id = $3`,
      [student.student_id, course.course_id, course.exam_cycle_id]);
      expect(marks.rows).toContainEqual({ internal_marks: 15, midsem_marks: 18, endsem_marks: 55 });

      const result = await client.query<{
        total_marks: number; max_marks: number; is_final_attempt: boolean; grade: string; grade_points: number;
      }>(`
        SELECT total_marks, max_marks, is_final_attempt, grade, grade_points
        FROM course_result
        WHERE student_id = $1 AND course_id = $2 AND is_final_attempt`,
      [student.student_id, course.course_id]);
      expect(result.rows).toHaveLength(1);
      const scale = await client.query<{ grade: string; grade_points: number }>(`
        SELECT grade, grade_points FROM grade_scale
        WHERE 88 BETWEEN min_percentage AND max_percentage
        ORDER BY min_percentage DESC LIMIT 1`);
      expect(result.rows[0]).toMatchObject({
        total_marks: 88,
        max_marks: course.total_max,
        is_final_attempt: true,
        grade: scale.rows[0]!.grade,
        grade_points: scale.rows[0]!.grade_points,
      });

      const summaries = await client.query<{
        sgpa: number;
        expected_sgpa: number;
        cgpa: number;
        expected_cgpa: number;
      }>(`
        SELECT sr.sgpa,
               (SELECT round(sum(c.credits * r.grade_points) / NULLIF(sum(c.credits), 0), 2)
                FROM course_result r JOIN course c USING (course_id)
                WHERE r.student_id = sr.student_id
                  AND r.academic_session_id = sr.academic_session_id
                  AND r.semester = sr.semester AND r.is_final_attempt) AS expected_sgpa,
               sc.cgpa, calculate_cgpa(sc.student_id) AS expected_cgpa
        FROM course_result r
        JOIN semester_result sr
          ON sr.student_id = r.student_id
         AND sr.academic_session_id = r.academic_session_id
         AND sr.semester = r.semester
        JOIN student_cgpa sc ON sc.student_id = r.student_id
        WHERE r.student_id = $1 AND r.course_id = $2 AND r.is_final_attempt`,
      [student.student_id, course.course_id]);
      expect(summaries.rows[0]!.sgpa).toBe(summaries.rows[0]!.expected_sgpa);
      expect(summaries.rows[0]!.cgpa).toBe(summaries.rows[0]!.expected_cgpa);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
