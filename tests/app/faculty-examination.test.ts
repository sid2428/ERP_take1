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
  const app = hasAppEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);
  const db = pool!;
  let faculty: Awaited<ReturnType<typeof signIn>>['agent'];
  let facultyId = 0;
  let fixture: {
    courseId: number;
    cycleId: number;
    sessionId: string;
    schemeCreated: boolean;
    gradeCreated: boolean;
  } | undefined;
  let summarySnapshot: {
    studentId: number;
    semesterResult: {
      semester_result_id: number;
      semester: number;
      credits_registered: number;
      credits_earned: number;
      sgpa: number;
      backlogs: number;
      result_status: string;
    } | null;
    cgpa: {
      semesters_completed: number;
      credits_attempted: number;
      credits_earned: number;
      cgpa: number;
      backlog_count: number;
    } | null;
    courseResults: { attempt_no: number; is_final_attempt: boolean }[];
  } | undefined;

  beforeAll(async () => {
    const login = await signIn(app, 'FAC-CSE-074', DEMO);
    expect(login.res.status).toBe(302);
    faculty = login.agent;
    const result = await db.query<{ faculty_id: number }>(
      `SELECT faculty_id FROM faculty WHERE faculty_code = 'FAC-CSE-074'`);
    facultyId = result.rows[0]!.faculty_id;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path=erp,public');
      const gradeCreated = (await client.query(`INSERT INTO grade_scale(grade,min_percentage,max_percentage,grade_points,description)
        VALUES('X2',0,100,8,'faculty examination test') ON CONFLICT(grade) DO NOTHING RETURNING grade`)).rows.length > 0;
      const chosen = await client.query<{course_id:number;session_id:string}>(`
        SELECT c.course_id,ta.academic_session_id AS session_id FROM teaching_assignment ta
        JOIN course c USING(course_id) JOIN v_assignment_roster r USING(assignment_id)
        WHERE ta.faculty_id=$1 AND ta.academic_session_id=current_session_id() AND c.course_type='TH'
          AND (NOT EXISTS(SELECT 1 FROM course_exam_scheme s WHERE s.course_id=c.course_id)
            OR EXISTS(SELECT 1 FROM course_exam_scheme s WHERE s.course_id=c.course_id
              AND (s.internal_max,s.midsem_max,s.endsem_max,s.total_max)=(20,20,60,100)))
        ORDER BY c.course_id LIMIT 1`,[facultyId]);
      if (!chosen.rows[0]) throw new Error('No assigned theory course for faculty examination fixture');
      const courseId=chosen.rows[0].course_id;
      const schemeCreated=(await client.query(`INSERT INTO course_exam_scheme(course_id,internal_max,midsem_max,endsem_max,total_max)
        VALUES($1,20,20,60,100) ON CONFLICT(course_id) DO NOTHING RETURNING course_id`,[courseId])).rows.length>0;
      const cycle=await client.query<{exam_cycle_id:number}>(`INSERT INTO exam_cycle(academic_session_id,exam_type,start_date,end_date,status)
        VALUES($1,'EndSem',current_date+100,current_date+101,'Upcoming') RETURNING exam_cycle_id`,[chosen.rows[0].session_id]);
      fixture={
        courseId,
        cycleId: cycle.rows[0]!.exam_cycle_id,
        sessionId: chosen.rows[0]!.session_id,
        schemeCreated,
        gradeCreated,
      };
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  afterAll(async () => {
    if(fixture) {
      if (summarySnapshot) {
        await db.query(`DELETE FROM course_result
          WHERE student_id=$1 AND course_id=$2
            AND NOT (attempt_no = ANY($3::smallint[]))`, [
          summarySnapshot.studentId,
          fixture.courseId,
          summarySnapshot.courseResults.map((result) => result.attempt_no),
        ]);
        for (const result of summarySnapshot.courseResults) {
          await db.query(`UPDATE course_result SET is_final_attempt=$4
            WHERE student_id=$1 AND course_id=$2 AND attempt_no=$3`, [
            summarySnapshot.studentId,
            fixture.courseId,
            result.attempt_no,
            result.is_final_attempt,
          ]);
        }
        await db.query('DELETE FROM exam_marks WHERE course_id=$1 AND exam_cycle_id=$2', [fixture.courseId, fixture.cycleId]);
        if (summarySnapshot.semesterResult) {
          const result = summarySnapshot.semesterResult;
          await db.query(`UPDATE semester_result
            SET semester=$2, credits_registered=$3, credits_earned=$4, sgpa=$5, backlogs=$6, result_status=$7
            WHERE semester_result_id=$1`, [
            result.semester_result_id,
            result.semester,
            result.credits_registered,
            result.credits_earned,
            result.sgpa,
            result.backlogs,
            result.result_status,
          ]);
        } else {
          await db.query('DELETE FROM semester_result WHERE student_id=$1 AND academic_session_id=$2', [
            summarySnapshot.studentId,
            fixture.sessionId,
          ]);
        }
        if (summarySnapshot.cgpa) {
          const cgpa = summarySnapshot.cgpa;
          await db.query(`UPDATE student_cgpa
            SET semesters_completed=$2, credits_attempted=$3, credits_earned=$4, cgpa=$5, backlog_count=$6
            WHERE student_id=$1`, [
            summarySnapshot.studentId,
            cgpa.semesters_completed,
            cgpa.credits_attempted,
            cgpa.credits_earned,
            cgpa.cgpa,
            cgpa.backlog_count,
          ]);
        } else {
          await db.query('DELETE FROM student_cgpa WHERE student_id=$1', [summarySnapshot.studentId]);
        }
      }
      await db.query('DELETE FROM exam_cycle WHERE exam_cycle_id=$1',[fixture.cycleId]);
      if(fixture.schemeCreated) await db.query('DELETE FROM course_exam_scheme WHERE course_id=$1',[fixture.courseId]);
      if(fixture.gradeCreated) await db.query("DELETE FROM grade_scale WHERE grade='X2' AND description='faculty examination test'");
    }
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
      course_id: number;
      roster_size: number;
      exam_cycle_id: number | null;
      total_max: number | null;
      course_type: string;
    }) => item.course_id===fixture?.courseId && item.roster_size > 0 && item.exam_cycle_id === fixture.cycleId
      && item.total_max === 100 && item.course_type === 'TH');
    expect(course).toBeDefined();

    const detail = await faculty.get(
      `/faculty/examination/courses/${course.course_id}?exam_cycle_id=${course.exam_cycle_id}`,
    ).set('Accept', 'application/json');
    expect(detail.status).toBe(200);
    expect(detail.body.course).toMatchObject({
      internal_max: 20,
      midsem_max: 20,
      endsem_max: 60,
      total_max: 100,
    });
    const student = detail.body.students[0] as { student_id: number };
    expect(student).toBeDefined();

    const marksEndpoint = `/faculty/examination/courses/${course.course_id}/marks`;
    const submit = (values: { internal_marks: unknown; midsem_marks: unknown; endsem_marks: unknown }) =>
      postForm(faculty, '/faculty/examination', marksEndpoint, {
        exam_cycle_id: String(course.exam_cycle_id),
        entries_json: JSON.stringify([{
          student_id: student.student_id,
          ...values,
        }]),
      });

    for (const invalid of [
      { internal_marks: 21, midsem_marks: null, endsem_marks: null },
      { internal_marks: null, midsem_marks: 21, endsem_marks: null },
      { internal_marks: null, midsem_marks: null, endsem_marks: 61 },
      { internal_marks: -0.1, midsem_marks: null, endsem_marks: null },
      { internal_marks: 'not numeric', midsem_marks: null, endsem_marks: null },
    ]) {
      const rejected = await submit(invalid);
      expect(rejected.status).toBe(400);
    }

    const previousSemester = await db.query<NonNullable<typeof summarySnapshot>['semesterResult'] & object>(`
      SELECT semester_result_id, semester, credits_registered, credits_earned, sgpa, backlogs, result_status
      FROM semester_result WHERE student_id=$1 AND academic_session_id=$2`,
    [student.student_id, fixture!.sessionId]);
    const previousCgpa = await db.query<NonNullable<typeof summarySnapshot>['cgpa'] & object>(`
      SELECT semesters_completed, credits_attempted, credits_earned, cgpa, backlog_count
      FROM student_cgpa WHERE student_id=$1`,
    [student.student_id]);
    const previousCourseResults = await db.query<{ attempt_no: number; is_final_attempt: boolean }>(`
      SELECT attempt_no, is_final_attempt FROM course_result
      WHERE student_id=$1 AND course_id=$2`,
    [student.student_id, course.course_id]);
    summarySnapshot = {
      studentId: student.student_id,
      semesterResult: previousSemester.rows[0] ?? null,
      cgpa: previousCgpa.rows[0] ?? null,
      courseResults: previousCourseResults.rows,
    };

    const valid = await submit({ internal_marks: 15, midsem_marks: 18, endsem_marks: 55 });
    expect(valid.status).toBe(200);
    expect(valid.body.saved).toBe(1);

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

      const reloaded = await faculty.get(
        `/faculty/examination/courses/${course.course_id}?exam_cycle_id=${course.exam_cycle_id}`,
      ).set('Accept', 'application/json');
      expect(reloaded.status).toBe(200);
      expect(reloaded.body.students.find((item: { student_id: number }) =>
        item.student_id === student.student_id)).toMatchObject({
        internal_marks: 15,
        midsem_marks: 18,
        endsem_marks: 55,
      });

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
