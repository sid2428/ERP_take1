import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };
const { saveFacultyAttendance } = hasAppEnv
  ? await import('../../src/queries/faculty-attendance-queries.js')
  : { saveFacultyAttendance: null };

describe.skipIf(!hasAppEnv)('faculty attendance', () => {
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

  it('protects the attendance page and assignment list with faculty authentication', async () => {
    const anonymous = await request(app).get('/faculty/attendance');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toContain('/login');

    const page = await faculty.get('/faculty/attendance');
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-faculty-attendance');
    expect(page.text).toContain('/static/js/faculty-attendance.js');

    const response = await faculty.get('/faculty/attendance/assignments').set('Accept', 'application/json');
    expect(response.status).toBe(200);
    expect(response.body.assignments.length).toBeGreaterThan(0);
    expect(response.body.assignments.every((assignment: { assignment_id: number }) =>
      Number.isInteger(assignment.assignment_id))).toBe(true);
  });

  it('lists only owned assignments and rejects another faculty member’s class', async () => {
    const response = await faculty.get('/faculty/attendance/assignments').set('Accept', 'application/json');
    const ownIds = response.body.assignments.map((assignment: { assignment_id: number }) => assignment.assignment_id);
    const other = await db.query<{ assignment_id: number }>(`
      SELECT assignment_id FROM teaching_assignment
      WHERE faculty_id <> $1 AND academic_session_id = current_session_id()
      ORDER BY assignment_id LIMIT 1`, [facultyId]);
    expect(other.rows[0]).toBeDefined();
    expect(ownIds).not.toContain(other.rows[0]!.assignment_id);

    const forbiddenPage = await faculty.get(
      `/faculty/attendance/assignments/${other.rows[0]!.assignment_id}/roster?date=2026-10-22`,
    ).set('Accept', 'application/json');
    expect(forbiddenPage.status).toBe(404);

    const save = await postForm(faculty, '/faculty/attendance',
      `/faculty/attendance/assignments/${other.rows[0]!.assignment_id}/sessions`,
      { session_date: '2026-10-22', absent_student_ids: '[]' });
    expect(save.status).toBe(404);
  });

  it('reads a class roster and session history only for an assigned class', async () => {
    const assignments = await faculty.get('/faculty/attendance/assignments').set('Accept', 'application/json');
    const assignment = assignments.body.assignments.find((item: { students: number }) => item.students > 0);
    expect(assignment).toBeDefined();

    const roster = await faculty.get(
      `/faculty/attendance/assignments/${assignment.assignment_id}/roster?date=${assignment.term_end}`,
    ).set('Accept', 'application/json');
    expect(roster.status).toBe(200);
    expect(roster.body.students.length).toBeGreaterThan(0);
    expect(roster.body.students[0]).toEqual(expect.objectContaining({
      student_id: expect.any(Number),
      student_number: expect.any(String),
      status: expect.stringMatching(/^(P|A)$/),
    }));

    const sessions = await faculty.get(
      `/faculty/attendance/assignments/${assignment.assignment_id}/sessions`,
    ).set('Accept', 'application/json');
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions).toEqual(expect.any(Array));
  });

  it('rejects marking a student outside the assigned roster', async () => {
    const response = await faculty.get('/faculty/attendance/assignments').set('Accept', 'application/json');
    const assignment = response.body.assignments.find((item: { students: number }) => item.students > 0);
    expect(assignment).toBeDefined();
    const result = await postForm(faculty, '/faculty/attendance',
      `/faculty/attendance/assignments/${assignment.assignment_id}/sessions`,
      { session_date: assignment.term_end, absent_student_ids: '[2147483647]' });
    expect(result.status).toBe(400);
  });

  it('creates and edits attendance transactionally and refreshes student totals', async () => {
    const response = await faculty.get('/faculty/attendance/assignments').set('Accept', 'application/json');
    const assignment = response.body.assignments.find((item: { students: number }) => item.students > 0);
    expect(assignment).toBeDefined();
    const rosterResponse = await faculty.get(
      `/faculty/attendance/assignments/${assignment.assignment_id}/roster?date=${assignment.term_end}`,
    ).set('Accept', 'application/json');
    const roster = rosterResponse.body.students as Array<{ student_id: number }>;
    const targetStudent = roster[0]!.student_id;

    const client = await db.connect();
    let beforeSession: unknown;
    let beforeSummary: unknown;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = erp, public');
      beforeSession = (await client.query(`
        SELECT session_id, session_number, absent_student_ids, marked_by
        FROM attendance_session WHERE assignment_id = $1 AND session_date = $2`,
      [assignment.assignment_id, assignment.term_end])).rows[0] ?? null;
      beforeSummary = (await client.query(`
        SELECT total_sessions, attended FROM attendance_summary
        WHERE student_id = $1 AND course_id = $2 AND academic_session_id = current_session_id()`,
      [targetStudent, assignment.course_id])).rows[0] ?? null;

      const first = await saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, assignment.term_end, roster.map((student) => student.student_id),
      );
      const afterAbsent = (await client.query<{ total_sessions: number; attended: number }>(`
        SELECT total_sessions, attended FROM attendance_summary
        WHERE student_id = $1 AND course_id = $2 AND academic_session_id = current_session_id()`,
      [targetStudent, assignment.course_id])).rows[0]!;
      const second = await saveFacultyAttendance!(client, facultyId, assignment.assignment_id, assignment.term_end, []);
      const afterPresent = (await client.query<{ total_sessions: number; attended: number }>(`
        SELECT total_sessions, attended FROM attendance_summary
        WHERE student_id = $1 AND course_id = $2 AND academic_session_id = current_session_id()`,
      [targetStudent, assignment.course_id])).rows[0]!;
      const studentView = (await client.query<{ total_sessions: number; attended: number; attendance_pct: number | null }>(`
        SELECT total_sessions, attended, attendance_pct
        FROM v_student_attendance_by_course
        WHERE student_id = $1 AND course_id = $2 AND academic_session_id = current_session_id()`,
      [targetStudent, assignment.course_id])).rows[0]!;

      expect(first.session_id).toBe(second.session_id);
      expect(second.created).toBe(false);
      expect(afterPresent.total_sessions).toBe(afterAbsent.total_sessions);
      expect(afterPresent.attended).toBe(afterAbsent.attended + 1);
      expect(studentView).toMatchObject(afterPresent);
    } finally {
      await client.query('ROLLBACK');
      try {
        const afterSession = (await client.query(`
          SELECT session_id, session_number, absent_student_ids, marked_by
          FROM attendance_session WHERE assignment_id = $1 AND session_date = $2`,
        [assignment.assignment_id, assignment.term_end])).rows[0] ?? null;
        const afterSummary = (await client.query(`
          SELECT total_sessions, attended FROM attendance_summary
          WHERE student_id = $1 AND course_id = $2 AND academic_session_id = current_session_id()`,
        [targetStudent, assignment.course_id])).rows[0] ?? null;
        expect(afterSession).toEqual(beforeSession);
        expect(afterSummary).toEqual(beforeSummary);
      } finally {
        client.release();
      }
    }
  });
});
