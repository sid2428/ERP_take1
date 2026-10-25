import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const ADMIN = process.env.ADMIN_PASSWORD ?? '';
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };
const { saveFacultyAttendance } = hasAppEnv
  ? await import('../../src/queries/faculty-attendance-queries.js')
  : { saveFacultyAttendance: null };
const { saveFacultyExtraAttendance } = hasAppEnv
  ? await import('../../src/queries/faculty-attendance-queries.js')
  : { saveFacultyExtraAttendance: null };
const {
  requestFacultyAttendanceUnlock, decideAttendanceUnlock,
} = hasAppEnv ? await import('../../src/queries/attendance-unlock-queries.js')
  : { requestFacultyAttendanceUnlock: null, decideAttendanceUnlock: null };

function shiftDate(value: string, days: number): string {
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function findDate(
  start: string, end: string, predicate: (date: Date, value: string) => boolean,
  direction = -1,
): string {
  for (let value = direction < 0 ? end : start;
    direction < 0 ? value >= start : value <= end;
    value = shiftDate(value, direction)) {
    if (predicate(new Date(value + 'T00:00:00Z'), value)) return value;
  }
  throw new Error(`No matching test date between ${start} and ${end}.`);
}

function findOldScheduledDate(calendar: {
  today: string; term_start: string; allowed_weekdays: number[];
}): string {
  return findDate(calendar.term_start, shiftDate(calendar.today, -15),
    (day) => calendar.allowed_weekdays.includes(day.getUTCDay() || 7));
}

describe.skipIf(!hasAppEnv)('faculty attendance', () => {
  const app = hasAppEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);
  const db = pool!;
  let faculty: Awaited<ReturnType<typeof signIn>>['agent'];
  let facultyId = 0;
  let facultyUserId = 0;
  let adminUserId = 0;

  beforeAll(async () => {
    const login = await signIn(app, 'FAC-CSE-074', DEMO);
    expect(login.res.status).toBe(302);
    faculty = login.agent;
    const result = await db.query<{ faculty_id: number; user_id: number }>(`
      SELECT f.faculty_id, u.user_id
      FROM faculty f JOIN app_user u USING (faculty_id)
      WHERE f.faculty_code = 'FAC-CSE-074'`);
    facultyId = result.rows[0]!.faculty_id;
    facultyUserId = result.rows[0]!.user_id;
    adminUserId = (await db.query<{ user_id: number }>(
      `SELECT user_id FROM app_user WHERE login_id = 'admin' AND role = 'admin'`,
    )).rows[0]!.user_id;
  });

  async function getCalendarAssignment() {
    const response = await faculty.get('/faculty/attendance/assignments').set('Accept', 'application/json');
    const assignment = response.body.assignments.find((item: { students: number }) => item.students > 0);
    expect(assignment).toBeDefined();
    const calendarResponse = await faculty.get(
      `/faculty/attendance/assignments/${assignment.assignment_id}/calendar`,
    ).set('Accept', 'application/json');
    expect(calendarResponse.status).toBe(200);
    return { assignment, calendar: calendarResponse.body.calendar };
  }

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

    const extra = await postForm(faculty, '/faculty/attendance',
      `/faculty/attendance/assignments/${other.rows[0]!.assignment_id}/extra-sessions`,
      { session_date: '2026-10-25', absent_student_ids: '[]', reason: 'Department event' });
    expect(extra.status).toBe(404);
  });

  it('accepts a scheduled weekday for attendance', async () => {
    const { assignment, calendar } = await getCalendarAssignment();
    const end = calendar.today < calendar.term_end ? calendar.today : calendar.term_end;
    const date = findDate(calendar.term_start, end, (day) => calendar.allowed_weekdays.includes(
      day.getUTCDay() || 7));
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = erp, public');
      const result = await saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, date, [],
      );
      expect(result.session_id).toEqual(expect.any(Number));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects a weekend date for regular attendance', async () => {
    const { assignment, calendar } = await getCalendarAssignment();
    const end = calendar.today < calendar.term_end ? calendar.today : calendar.term_end;
    const date = findDate(calendar.term_start, end,
      (day) => day.getUTCDay() === 0 || day.getUTCDay() === 6);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = erp, public');
      await expect(saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, date, [],
      )).rejects.toThrow(/weekends/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('accepts an extra session on Sunday and stores its metadata', async () => {
    const { assignment, calendar } = await getCalendarAssignment();
    const end = calendar.today < calendar.term_end ? calendar.today : calendar.term_end;
    const sunday = findDate(calendar.term_start, end, (day) => day.getUTCDay() === 0);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = erp, public');
      const result = await saveFacultyExtraAttendance!(
        client, facultyId, assignment.assignment_id, sunday, [], 'Make-up lecture',
      );
      const saved = await client.query<{ is_extra: boolean; reason: string; created_by: number }>(`
        SELECT is_extra, reason, created_by FROM attendance_session WHERE session_id = $1`,
      [result.session_id]);
      expect(result.created).toBe(true);
      expect(saved.rows[0]).toEqual({
        is_extra: true, reason: 'Make-up lecture', created_by: facultyId,
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects a future attendance date', async () => {
    const { assignment, calendar } = await getCalendarAssignment();
    const future = shiftDate(calendar.today, 1);
    expect(calendar.term_end >= future).toBe(true);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = erp, public');
      await expect(saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, future, [],
      )).rejects.toThrow(/future date/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('allows edits within 14 days and rejects day 15 without an unlock', async () => {
    const { assignment, calendar } = await getCalendarAssignment();
    const recent = findDate(shiftDate(calendar.today, -13), calendar.today,
      (day) => calendar.allowed_weekdays.includes(day.getUTCDay() || 7));
    const lockedDate = shiftDate(calendar.today, -15);
    expect(calendar.term_start <= lockedDate).toBe(true);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = erp, public');
      const recentSave = await saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, recent, [],
      );
      await saveFacultyAttendance!(client, facultyId, assignment.assignment_id, recent, []);
      expect(recentSave.session_id).toEqual(expect.any(Number));

      const oldSession = await client.query<{ session_id: number }>(`
        INSERT INTO attendance_session
          (assignment_id, session_date, session_number, duration_hrs, session_status,
           absent_student_ids, marked_by, marked_at)
        VALUES ($1, $2, COALESCE((SELECT max(session_number) + 1 FROM attendance_session WHERE assignment_id = $1), 1),
                1, 'Conducted', '{}', $3, now())
        ON CONFLICT (assignment_id, session_date) WHERE is_extra = false
        DO UPDATE SET absent_student_ids = '{}'
        RETURNING session_id`, [assignment.assignment_id, lockedDate, facultyId]);
      await expect(saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, lockedDate, [],
      )).rejects.toThrow(/locked/);
      expect(oldSession.rows[0]!.session_id).toEqual(expect.any(Number));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('requests and approves a locked session, permits its edit, then relocks after 48 hours', async () => {
    const { assignment, calendar } = await getCalendarAssignment();
    const lockedDate = findOldScheduledDate(calendar);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = erp, public');
      const created = await client.query<{ session_id: number }>(`
        INSERT INTO attendance_session
          (assignment_id, session_date, session_number, duration_hrs, session_status,
           absent_student_ids, marked_by, marked_at)
        VALUES ($1, $2, COALESCE((SELECT max(session_number) + 1 FROM attendance_session WHERE assignment_id = $1), 1),
                1, 'Conducted', '{}', $3, now())
        ON CONFLICT (assignment_id, session_date) WHERE is_extra = false
        DO UPDATE SET absent_student_ids = '{}'
        RETURNING session_id`, [assignment.assignment_id, lockedDate, facultyId]);
      const sessionId = created.rows[0]!.session_id;
      const unlock = await requestFacultyAttendanceUnlock!(
        client, facultyId, facultyUserId, assignment.assignment_id, sessionId, 'Correcting an attendance entry',
      );
      const approved = await decideAttendanceUnlock!(client, unlock.request_id, adminUserId, 'approved');
      expect(approved.status).toBe('approved');
      expect(approved.unlock_expires_at).toBeTruthy();
      const saved = await saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, lockedDate, [], sessionId,
      );
      expect(saved.session_id).toBe(sessionId);
      const audit = await client.query<{ action: string; request_id: number }>(`
        SELECT action, request_id FROM attendance_session_audit WHERE session_id = $1 ORDER BY audit_id`,
      [sessionId]);
      expect(audit.rows.map((entry) => entry.action)).toEqual(['unlock_approved', 'attendance_edit']);
      expect(audit.rows.every((entry) => entry.request_id === unlock.request_id)).toBe(true);

      await client.query(`
        UPDATE attendance_unlock_request SET unlock_expires_at = now() - interval '1 minute'
        WHERE request_id = $1`, [unlock.request_id]);
      await expect(saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, lockedDate, [], sessionId,
      )).rejects.toThrow(/locked/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('keeps rejected sessions locked and prevents faculty from approving requests', async () => {
    const { assignment, calendar } = await getCalendarAssignment();
    const lockedDate = findOldScheduledDate(calendar);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = erp, public');
      const created = await client.query<{ session_id: number }>(`
        INSERT INTO attendance_session
          (assignment_id, session_date, session_number, duration_hrs, session_status,
           absent_student_ids, marked_by, marked_at)
        VALUES ($1, $2, COALESCE((SELECT max(session_number) + 1 FROM attendance_session WHERE assignment_id = $1), 1),
                1, 'Conducted', '{}', $3, now())
        ON CONFLICT (assignment_id, session_date) WHERE is_extra = false
        DO UPDATE SET absent_student_ids = '{}'
        RETURNING session_id`, [assignment.assignment_id, lockedDate, facultyId]);
      const sessionId = created.rows[0]!.session_id;
      const unlock = await requestFacultyAttendanceUnlock!(
        client, facultyId, facultyUserId, assignment.assignment_id, sessionId, 'Requesting review',
      );
      const facultyApproval = await postForm(
        faculty, '/faculty/attendance', `/admin/attendance-unlocks/${unlock.request_id}/approved`, {},
      );
      expect(facultyApproval.status).toBe(403);
      await expect(decideAttendanceUnlock!(client, unlock.request_id, facultyUserId, 'approved'))
        .rejects.toThrow(/Only an active admin/);
      const rejected = await decideAttendanceUnlock!(client, unlock.request_id, adminUserId, 'rejected');
      expect(rejected.status).toBe('rejected');
      await expect(saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, lockedDate, [], sessionId,
      )).rejects.toThrow(/locked/);
      const audit = await client.query<{ action: string }>(
        'SELECT action FROM attendance_session_audit WHERE request_id = $1', [unlock.request_id]);
      expect(audit.rows.map((entry) => entry.action)).toEqual(['unlock_rejected']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
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
    const { assignment, calendar } = await getCalendarAssignment();
    const end = calendar.today < calendar.term_end ? calendar.today : calendar.term_end;
    const date = findDate(calendar.term_start, end, (day) => calendar.allowed_weekdays.includes(
      day.getUTCDay() || 7));
    const rosterResponse = await faculty.get(
      `/faculty/attendance/assignments/${assignment.assignment_id}/roster?date=${date}`,
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
        FROM attendance_session WHERE assignment_id = $1 AND session_date = $2 AND is_extra = false`,
      [assignment.assignment_id, date])).rows[0] ?? null;
      beforeSummary = (await client.query(`
        SELECT total_sessions, attended FROM attendance_summary
        WHERE student_id = $1 AND course_id = $2 AND academic_session_id = current_session_id()`,
      [targetStudent, assignment.course_id])).rows[0] ?? null;

      const first = await saveFacultyAttendance!(
        client, facultyId, assignment.assignment_id, date, roster.map((student) => student.student_id),
      );
      const afterAbsent = (await client.query<{ total_sessions: number; attended: number }>(`
        SELECT total_sessions, attended FROM attendance_summary
        WHERE student_id = $1 AND course_id = $2 AND academic_session_id = current_session_id()`,
      [targetStudent, assignment.course_id])).rows[0]!;
      const second = await saveFacultyAttendance!(client, facultyId, assignment.assignment_id, date, []);
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
          FROM attendance_session WHERE assignment_id = $1 AND session_date = $2 AND is_extra = false`,
        [assignment.assignment_id, date])).rows[0] ?? null;
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
