import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { hasAppEnv, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };

describe.skipIf(!hasAppEnv)('student read-only API', () => {
  const app = createApp!();

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
