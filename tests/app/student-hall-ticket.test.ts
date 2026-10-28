import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAppEnv)('student hall-ticket issue and print flow', () => {
  const app = hasAppEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);
  const db = pool!;
  let fixture: {
    studentId: number;
    cycleId: number;
    eligibleCourseId: number;
    eligibleCourseCode: string;
    blockedCourseId: number;
    blockedCourseCode: string;
  } | undefined;

  beforeAll(async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path=erp,public');
      const eligible = await client.query<{
        student_id: number;
        academic_session_id: string;
        course_id: number;
        course_code: string;
      }>(`
        SELECT s.student_id, a.academic_session_id, c.course_id, c.course_code
        FROM student s
        JOIN attendance_summary a ON a.student_id = s.student_id
        JOIN course c USING (course_id)
        WHERE s.student_number = 'STU202600004'
          AND a.academic_session_id = current_session_id()
          AND a.attendance_pct >= 75
        ORDER BY c.course_id
        LIMIT 1`);
      if (!eligible.rows[0]) throw new Error('No 75%-eligible course is available for the hall-ticket fixture.');
      const blocked = await client.query<{ course_id: number; course_code: string }>(`
        SELECT course_id, course_code FROM course
        WHERE course_id <> $1 ORDER BY course_id LIMIT 1`, [eligible.rows[0].course_id]);
      if (!blocked.rows[0]) throw new Error('No second course is available for the hall-ticket fixture.');

      const cycle = await client.query<{ exam_cycle_id: number }>(`
        INSERT INTO exam_cycle (academic_session_id, exam_type, start_date, end_date, status)
        VALUES ($1, 'EndSem', current_date, current_date + 1, 'Upcoming')
        RETURNING exam_cycle_id`, [eligible.rows[0].academic_session_id]);
      const cycleId = cycle.rows[0]!.exam_cycle_id;
      await client.query(`
        INSERT INTO exam_schedule
          (exam_cycle_id, course_id, exam_mode, exam_date, session, start_time, end_time, duration_min, max_marks)
        VALUES
          ($1, $2, 'EndSem Theory', current_date, 'Morning', '09:00', '12:00', 180, 60),
          ($1, $3, 'EndSem Theory', current_date + 1, 'Afternoon', '13:00', '16:00', 180, 60)`,
      [cycleId, eligible.rows[0].course_id, blocked.rows[0].course_id]);
      await client.query(`
        INSERT INTO exam_registration (student_id, course_id, exam_cycle_id, registration_status)
        VALUES ($1, $2, $3, 'Registered'), ($1, $4, $3, 'Blocked')`,
      [eligible.rows[0].student_id, eligible.rows[0].course_id, cycleId, blocked.rows[0].course_id]);
      fixture = {
        studentId: eligible.rows[0].student_id,
        cycleId,
        eligibleCourseId: eligible.rows[0].course_id,
        eligibleCourseCode: eligible.rows[0].course_code,
        blockedCourseId: blocked.rows[0].course_id,
        blockedCourseCode: blocked.rows[0].course_code,
      };
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    if (!fixture) return;
    await db.query('DELETE FROM hall_ticket WHERE student_id = $1 AND exam_cycle_id = $2', [fixture.studentId, fixture.cycleId]);
    await db.query('DELETE FROM exam_registration WHERE student_id = $1 AND exam_cycle_id = $2', [fixture.studentId, fixture.cycleId]);
    await db.query('DELETE FROM exam_schedule WHERE exam_cycle_id = $1', [fixture.cycleId]);
    await db.query('DELETE FROM exam_cycle WHERE exam_cycle_id = $1', [fixture.cycleId]);
  });

  it('issues a ticket containing eligible exams only and refuses an ineligible course POST', async () => {
    const { agent, res: login } = await signIn(app, 'STU202600004', DEMO);
    expect(login.status).toBe(302);

    const generated = await postForm(
      agent,
      '/student/hall-ticket',
      `/student/hall-ticket/${fixture!.cycleId}/generate`,
      {},
    );
    expect(generated.status).toBe(302);
    expect(generated.headers.location).toBe(`/student/hall-ticket/${fixture!.cycleId}`);

    const ticket = await agent.get(generated.headers.location!);
    expect(ticket.status).toBe(200);
    expect(ticket.text).toContain('HT');
    expect(ticket.text).toContain(fixture!.eligibleCourseCode);
    expect(ticket.text).not.toContain(fixture!.blockedCourseCode);
    expect(ticket.text).toContain('Student signature');
    expect(ticket.text).toContain('Invigilator signature');

    const status = await agent.get('/student/api/exams');
    const issuedExam = status.body.exams.find((exam: { exam_cycle_id: number }) => exam.exam_cycle_id === fixture!.cycleId);
    expect(issuedExam.hall_ticket_status).toBe('Issued');
    expect(issuedExam.hall_ticket_issued_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const refused = await postForm(
      agent,
      '/student/hall-ticket',
      `/student/hall-ticket/${fixture!.cycleId}/generate`,
      { course_id: String(fixture!.blockedCourseId) },
    );
    expect(refused.status).toBe(302);
    const errorPage = await agent.get(refused.headers.location!);
    expect(errorPage.text).toContain('This exam is not eligible for a hall ticket');
  });
});
