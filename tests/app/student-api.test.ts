import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAppEnv)('student read-only API', () => {
  const app = createApp!();
  const db = pool!;
  let fixture: { studentId: number; courseId: number; cycleId: number; schemeCreated: boolean; gradeCreated: boolean } | undefined;

  beforeAll(async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path=erp,public');
      const gradeCreated = (await client.query(`INSERT INTO grade_scale(grade,min_percentage,max_percentage,grade_points,description)
        VALUES('X1',0,100,8,'student API test') ON CONFLICT(grade) DO NOTHING RETURNING grade`)).rows.length > 0;
      const candidate = await client.query<{student_id:number;course_id:number;session_id:string;semester:number;faculty_id:number}>(`
        SELECT s.student_id,a.course_id,a.academic_session_id AS session_id,
          COALESCE((SELECT min(pc.semester_no) FROM program_curriculum pc WHERE pc.course_id=c.course_id),1) AS semester,
          (SELECT ta.faculty_id FROM teaching_assignment ta WHERE ta.course_id=c.course_id AND ta.academic_session_id=a.academic_session_id ORDER BY ta.assignment_id LIMIT 1) AS faculty_id
        FROM student s JOIN attendance_summary a USING(student_id) JOIN course c USING(course_id)
        WHERE s.student_number='STU202600004' AND a.academic_session_id=current_session_id()
          AND a.attendance_pct>=75 AND c.course_type='TH'
          AND NOT EXISTS(SELECT 1 FROM course_result existing WHERE existing.student_id=s.student_id)
          AND NOT EXISTS(SELECT 1 FROM student_cgpa existing WHERE existing.student_id=s.student_id)
          AND NOT EXISTS(SELECT 1 FROM semester_result existing WHERE existing.student_id=s.student_id)
          AND (NOT EXISTS(SELECT 1 FROM course_exam_scheme existing WHERE existing.course_id=c.course_id)
            OR EXISTS(SELECT 1 FROM course_exam_scheme existing WHERE existing.course_id=c.course_id
              AND (existing.internal_max,existing.midsem_max,existing.endsem_max,existing.total_max)=(20,20,60,100)))
          AND NOT EXISTS(SELECT 1 FROM exam_marks m WHERE m.student_id=s.student_id AND m.course_id=c.course_id)
          AND NOT EXISTS(SELECT 1 FROM course_result r WHERE r.student_id=s.student_id AND r.course_id=c.course_id)
        ORDER BY c.course_id LIMIT 1`);
      if (!candidate.rows[0]) throw new Error('No eligible unused theory course for student API fixture');
      const row = candidate.rows[0];
      const cycle = await client.query<{exam_cycle_id:number}>(`INSERT INTO exam_cycle(academic_session_id,exam_type,start_date,end_date,status)
        VALUES($1,'EndSem',current_date,current_date+1,'Upcoming') RETURNING exam_cycle_id`,[row.session_id]);
      const scheme = await client.query(`INSERT INTO course_exam_scheme(course_id,internal_max,midsem_max,endsem_max,total_max)
        VALUES($1,20,20,60,100) ON CONFLICT(course_id) DO NOTHING RETURNING course_id`,[row.course_id]);
      await client.query(`INSERT INTO exam_schedule(exam_cycle_id,course_id,exam_mode,exam_date,session,start_time,end_time,duration_min,max_marks)
        VALUES($1,$2,'EndSem Theory',current_date,'Morning','09:00','12:00',180,60)`,[cycle.rows[0]!.exam_cycle_id,row.course_id]);
      await client.query(`INSERT INTO exam_registration(student_id,course_id,exam_cycle_id,registration_status)
        VALUES($1,$2,$3,'Registered')`,[row.student_id,row.course_id,cycle.rows[0]!.exam_cycle_id]);
      if (!row.faculty_id) throw new Error('No faculty owner for student API result fixture');
      await client.query(`INSERT INTO exam_marks(student_id,course_id,attempt_no,exam_cycle_id,internal_marks,midsem_marks,endsem_marks,endsem_status,entered_by)
        VALUES($1,$2,1,$3,18,18,48,'Present',$4)`,[row.student_id,row.course_id,cycle.rows[0]!.exam_cycle_id,row.faculty_id]);
      const grade = await client.query<{grade:string;grade_points:number}>(`SELECT grade,grade_points FROM grade_scale WHERE grade='X1'`);
      if (!grade.rows[0]) throw new Error('Grade scale does not cover fixture marks');
      await client.query(`INSERT INTO course_result(student_id,course_id,academic_session_id,semester,attempt_no,total_marks,max_marks,percentage,grade,grade_points,result_status,is_final_attempt)
        VALUES($1,$2,$3,$4,1,84,100,84,$5,$6,'Pass',true)`,[row.student_id,row.course_id,row.session_id,row.semester,grade.rows[0].grade,grade.rows[0].grade_points]);
      await client.query(`INSERT INTO semester_result(student_id,academic_session_id,semester,credits_registered,credits_earned,sgpa,backlogs,result_status)
        VALUES($1,$2,$3,(SELECT credits FROM course WHERE course_id=$4),(SELECT credits FROM course WHERE course_id=$4),$5,0,'Pass')`,[row.student_id,row.session_id,row.semester, row.course_id,grade.rows[0].grade_points]);
      await client.query(`INSERT INTO student_cgpa(student_id,semesters_completed,credits_attempted,credits_earned,cgpa,backlog_count)
        VALUES($1,1,(SELECT credits FROM course WHERE course_id=$2),(SELECT credits FROM course WHERE course_id=$2),$3,0)`,[row.student_id,row.course_id,grade.rows[0].grade_points]);
      fixture={studentId:row.student_id,courseId:row.course_id,cycleId:cycle.rows[0]!.exam_cycle_id,schemeCreated:scheme.rows.length>0,gradeCreated};
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  afterAll(async () => {
    if (fixture) {
      await db.query('DELETE FROM student_cgpa WHERE student_id=$1',[fixture.studentId]);
      await db.query('DELETE FROM semester_result WHERE student_id=$1',[fixture.studentId]);
      await db.query('DELETE FROM course_result WHERE student_id=$1 AND course_id=$2',[fixture.studentId,fixture.courseId]);
      await db.query('DELETE FROM exam_marks WHERE student_id=$1 AND course_id=$2 AND exam_cycle_id=$3',[fixture.studentId,fixture.courseId,fixture.cycleId]);
      await db.query('DELETE FROM exam_registration WHERE student_id=$1 AND course_id=$2 AND exam_cycle_id=$3',[fixture.studentId,fixture.courseId,fixture.cycleId]);
      await db.query('DELETE FROM exam_schedule WHERE exam_cycle_id=$1',[fixture.cycleId]);
      await db.query('DELETE FROM exam_cycle WHERE exam_cycle_id=$1',[fixture.cycleId]);
      if(fixture.schemeCreated) await db.query('DELETE FROM course_exam_scheme WHERE course_id=$1',[fixture.courseId]);
      if(fixture.gradeCreated) await db.query("DELETE FROM grade_scale WHERE grade='X1' AND description='student API test'");
    }
    await db.end();
  });

  it('requires an authenticated student for each endpoint', async () => {
    for (const path of [
      '/student/api/attendance',
      '/student/api/attendance/1',
      '/student/api/exams',
      '/student/api/results',
    ]) {
      const response = await request(app).get(path).set('Accept', 'application/json');
      expect(response.status, path).toBe(302);
    }
  });

  it('does not allow faculty to use student endpoints', async () => {
    const { agent } = await signIn(app, 'FAC-CSE-074', DEMO);
    const response = await agent.get('/student/api/attendance').set('Accept', 'application/json');
    expect(response.status).toBe(403);
  });

  it('returns the signed-in student attendance summary split by theory and lab', async () => {
    const { agent, res: login } = await signIn(app, 'STU202600004', DEMO);
    expect(login.status).toBe(302);
    const response = await agent.get('/student/api/attendance?student_id=1').set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body.courses).toMatchObject({ theory: expect.any(Array), lab: expect.any(Array) });
    for (const course of [...response.body.courses.theory, ...response.body.courses.lab]) {
      expect(course).toEqual(expect.objectContaining({
        course_id: expect.any(Number),
        attended: expect.any(Number),
        total_sessions: expect.any(Number),
        below_75_percent: expect.any(Boolean),
      }));
    }
  });

  it('returns date-wise course attendance with bounded pagination', async () => {
    const { agent } = await signIn(app, 'STU202600004', DEMO);
    const summary = await agent.get('/student/api/attendance').set('Accept', 'application/json');
    const course = [...summary.body.courses.theory, ...summary.body.courses.lab][0];
    expect(course).toBeDefined();
    const response = await agent.get(`/student/api/attendance/${course.course_id}?page=1`)
      .set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      course_id: course.course_id,
      pagination: { page: 1, page_size: 25 },
    });
    expect(response.body.records).toEqual(expect.any(Array));
    if (response.body.records.length) {
      expect(response.body.records[0]).toEqual(expect.objectContaining({
        session_date: expect.any(String),
        status: expect.stringMatching(/^(P|A)$/),
      }));
    }
    const invalid = await agent.get(`/student/api/attendance/${course.course_id}?page=0`)
      .set('Accept', 'application/json');
    expect(invalid.status).toBe(400);
  });

  it('returns registered exam schedules and gates eligibility at 75 percent', async () => {
    const { agent } = await signIn(app, 'STU202600004', DEMO);
    const response = await agent.get('/student/api/exams').set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body.exams).toEqual(expect.any(Array));
    expect(response.body.exams.length).toBeGreaterThan(0);
    for (const exam of response.body.exams) {
      expect(exam.exam_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(exam.hall_ticket_eligible).toBe(
        exam.registration_status === 'Registered'
          && exam.attendance_pct !== null && exam.attendance_pct >= 75,
      );
    }
  });

  it('returns the signed-in student marks, semester results, and CGPA', async () => {
    const { agent } = await signIn(app, 'STU202600004', DEMO);
    const response = await agent.get('/student/api/results?student_id=1').set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      marks: expect.any(Array),
      course_results: expect.any(Array),
      semester_results: expect.any(Array),
      cgpa: expect.anything(),
    }));
    expect(response.body.course_results[0]).toEqual(expect.objectContaining({
      total_marks: expect.any(Number),
      grade: expect.any(String),
      course_type: expect.stringMatching(/^(TH|LAB|TUT)$/),
      internal_max: expect.any(Number),
      midsem_max: expect.any(Number),
      endsem_max: expect.any(Number),
    }));
    expect(response.body.semester_results[0]).toEqual(expect.objectContaining({ sgpa: expect.any(Number) }));
    expect(response.body.cgpa.cgpa).toEqual(expect.any(Number));
  });
});
