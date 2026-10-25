import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, csrfFrom, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const FACULTY = 'FAC-CSE-074';
let FACULTY_ID = 0;

const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAppEnv)('Faculty Dashboard API Endpoints', () => {
  const app = createApp!();
  type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
  let agent: Agent;
  let csrfToken = '';
  let originalMobileBeforeTest: string | null | undefined;
  let testGrievanceId: number | undefined;
  let testAttendanceSessionId: number | undefined;

  beforeAll(async () => {
    agent = (await signIn(app, FACULTY, DEMO)).agent;
    FACULTY_ID = (await pool!.query<{ faculty_id: number }>(
      'SELECT faculty_id FROM faculty WHERE faculty_code = $1', [FACULTY],
    )).rows[0]!.faculty_id;
    csrfToken = csrfFrom((await agent.get('/faculty')).text);
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      if (originalMobileBeforeTest !== undefined) {
        await pool.query('UPDATE faculty SET mobile_number = $1 WHERE faculty_id = $2', [originalMobileBeforeTest, FACULTY_ID]);
      }
      if (testAttendanceSessionId) {
        await pool.query(`DELETE FROM attendance_session WHERE session_id = $1 AND assignment_id IN
          (SELECT assignment_id FROM teaching_assignment WHERE faculty_id = $2)`, [testAttendanceSessionId, FACULTY_ID]);
      }
      if (testGrievanceId) {
        const link = `/admin/grievances/${testGrievanceId}`;
        await pool.query('DELETE FROM notification WHERE link = $1', [link]);
        await pool.query("DELETE FROM notice WHERE source = 'grievance' AND link = $1", [link]);
        await pool.query('DELETE FROM grievance WHERE grievance_id = $1', [testGrievanceId]);
      }
    } finally {
      await pool.end();
    }
  });

  it('protects both legacy mounts with session, role, ownership and CSRF checks', async () => {
    const anonymous = request(app);
    for (const path of [`/api/faculty/${FACULTY_ID}/dashboard`, `/faculty/api/faculty/${FACULTY_ID}/dashboard`]) {
      const response = await anonymous.get(path).set('Accept', 'application/json');
      expect(response.status).toBe(401);
      expect(response.body.error).toMatch(/authentication/i);
    }
    for (const path of [`/api/faculty/${FACULTY_ID}/leave/apply`, `/faculty/api/faculty/${FACULTY_ID}/leave/apply`]) {
      const anonymousMutation = await anonymous.post(path).send({ reason: 'test' });
      expect(anonymousMutation.status).toBe(401);
      expect(anonymousMutation.body.error).toMatch(/authentication/i);
    }

    const { agent: student } = await signIn(app, 'STU202600004', DEMO);
    const studentToken = csrfFrom((await student.get('/student')).text);
    const studentRead = await student.get(`/api/faculty/${FACULTY_ID}/dashboard`);
    expect(studentRead.status).toBe(403);
    expect(studentRead.body.error).toMatch(/faculty/i);
    const studentWrite = await student.post(`/faculty/api/faculty/${FACULTY_ID}/leave/apply`)
      .set('X-CSRF-Token', studentToken).send({ leaveTypeId: 1, fromDate: '2026-11-01', toDate: '2026-11-01', reason: 'test' });
    expect(studentWrite.status).toBe(403);

    const otherFacultyId = Number((await pool!.query<{ faculty_id: number }>(
      'SELECT faculty_id FROM faculty WHERE faculty_id <> $1 ORDER BY faculty_id LIMIT 1', [FACULTY_ID],
    )).rows[0]?.faculty_id);
    expect(otherFacultyId).toBeGreaterThan(0);
    const otherAssignmentId = Number((await pool!.query<{ assignment_id: number }>(
      'SELECT assignment_id FROM teaching_assignment WHERE faculty_id = $1 ORDER BY assignment_id LIMIT 1', [otherFacultyId],
    )).rows[0]?.assignment_id);
    expect(otherAssignmentId).toBeGreaterThan(0);
    const before = await pool!.query<{ mobile_number: string | null }>(
      'SELECT mobile_number FROM faculty WHERE faculty_id = $1', [otherFacultyId],
    );
    const crossRead = await agent.get(`/api/faculty/${otherFacultyId}/dashboard`);
    expect(crossRead.status).toBe(403);
    const crossWrite = await agent.put(`/faculty/api/faculty/${otherFacultyId}/profile`)
      .set('X-CSRF-Token', csrfToken).send({ mobileNumber: '9000000000' });
    expect(crossWrite.status).toBe(403);
    const after = await pool!.query<{ mobile_number: string | null }>(
      'SELECT mobile_number FROM faculty WHERE faculty_id = $1', [otherFacultyId],
    );
    expect(after.rows[0]?.mobile_number).toBe(before.rows[0]?.mobile_number);
    const crossRoster = await agent.get(`/api/faculty/${FACULTY_ID}/courses/${otherAssignmentId}/students`);
    expect(crossRoster.status).toBe(404);
    expect(crossRoster.body).not.toHaveProperty('studentId');
    const crossAttendance = await agent.post(`/api/faculty/${FACULTY_ID}/attendance/sessions`)
      .set('X-CSRF-Token', csrfToken).send({
        courseOfferingId: otherAssignmentId, sessionDate: '2026-11-04', records: [],
      });
    expect(crossAttendance.status).toBe(404);

    for (const id of ['0', '-1', 'abc']) {
      const invalid = await agent.get(`/api/faculty/${id}/dashboard`);
      expect(invalid.status).toBe(400);
    }
    expect((await agent.get(`/faculty/api/faculty/${FACULTY_ID}/dashboard`)).status).toBe(200);
    expect((await agent.get(`/api/faculty/${FACULTY_ID}/missing-route`).set('Accept', 'application/json')).status).toBe(404);
  });

  it('rejects missing and invalid CSRF tokens on legacy mutations', async () => {
    const payload = { leaveTypeId: 1, fromDate: '2026-11-03', toDate: '2026-11-03', reason: 'CSRF regression check' };
    const missing = await agent.post(`/api/faculty/${FACULTY_ID}/leave/apply`).send(payload);
    expect(missing.status).toBe(403);
    expect(missing.body.error).toMatch(/csrf/i);
    const invalid = await agent.post(`/api/faculty/${FACULTY_ID}/leave/apply`)
      .set('X-CSRF-Token', 'invalid-token').send(payload);
    expect(invalid.status).toBe(403);
    expect(invalid.body.error).toMatch(/csrf/i);
    const requests = (await agent.get(`/api/faculty/${FACULTY_ID}/leave/requests`)).body as Array<{ reason: string }>;
    expect(requests.some((item) => item.reason === 'CSRF regression check')).toBe(false);
  });

  it('1. GET /api/faculty/:id/dashboard returns overview, metrics and profile', async () => {
    const res = await agent.get(`/api/faculty/${FACULTY_ID}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.body.profile.facultyId).toBe(FACULTY_ID);
    expect(res.body.profile.fullName).toBeDefined();
    expect(typeof res.body.totalEnrolledStudents).toBe('number');
    expect(Array.isArray(res.body.courses)).toBe(true);
    expect(Array.isArray(res.body.todaySessions)).toBe(true);
  });

  it('2. GET /api/faculty/:id/courses returns course assignments', async () => {
    const res = await agent.get(`/api/faculty/${FACULTY_ID}/courses`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      const course = res.body[0];
      expect(course.courseCode).toBeDefined();
      expect(course.courseName).toBeDefined();
    }
  });

  it('3. GET /api/faculty/:id/timetable returns weekly timetable slots', async () => {
    const res = await agent.get(`/api/faculty/${FACULTY_ID}/timetable`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('4. GET /api/faculty/:id/students returns roster of taught students', async () => {
    const res = await agent.get(`/api/faculty/${FACULTY_ID}/students`);
    if (res.status !== 200) console.error('Students error:', res.body);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      const s = res.body[0];
      expect(s.studentId).toBeDefined();
      expect(s.enrollmentNo).toBeDefined();
      expect(s.fullName).toBeDefined();
    }
  });

  it('5. GET /api/faculty/:id/attendance/low returns students with attendance under threshold', async () => {
    const res = await agent.get(`/api/faculty/${FACULTY_ID}/attendance/low?threshold=75`);
    if (res.status !== 200) console.error('Low att error:', res.body);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('6. GET /api/faculty/:id/attendance/sessions returns session history', async () => {
    const res = await agent.get(`/api/faculty/${FACULTY_ID}/attendance/sessions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('7. GET /api/faculty/:id/attendance/audit returns audit logs', async () => {
    const res = await agent.get(`/api/faculty/${FACULTY_ID}/attendance/audit`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('8. Leave API: GET balance, POST apply, GET requests, and POST cancel', async () => {
    // 8a. Balance
    const balRes = await agent.get(`/api/faculty/${FACULTY_ID}/leave/balance`);
    expect(balRes.status).toBe(200);
    expect(Array.isArray(balRes.body)).toBe(true);
    expect(balRes.body.length).toBeGreaterThan(0);

    // 8b. Apply
    const applyRes = await agent.post(`/api/faculty/${FACULTY_ID}/leave/apply`).set('X-CSRF-Token', csrfToken).send({
      leaveTypeId: 1,
      fromDate: '2026-11-01',
      toDate: '2026-11-02',
      reason: 'Automated test leave application',
      replacementFaculty: 'Dr. Test Replacement',
    });
    expect(applyRes.status).toBe(200);
    expect(applyRes.body.success).toBe(true);
    const newReqId = applyRes.body.leaveRequestId;

    // 8c. Requests list
    const reqsRes = await agent.get(`/api/faculty/${FACULTY_ID}/leave/requests`);
    expect(reqsRes.status).toBe(200);
    const found = reqsRes.body.find((r: { leaveRequestId: number }) => r.leaveRequestId === newReqId);
    expect(found).toBeDefined();
    expect(found.reason).toBe('Automated test leave application');

    // 8d. Cancel
    const cancelRes = await agent.post(`/api/faculty/${FACULTY_ID}/leave/requests/${newReqId}/cancel`).set('X-CSRF-Token', csrfToken);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.success).toBe(true);
  });

  it('9. Payroll API: GET payslips, GET details, and GET salary structure', async () => {
    // 9a. List payslips
    const listRes = await agent.get(`/api/faculty/${FACULTY_ID}/payroll/payslips`);
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBeGreaterThan(0);

    // 9b. Single payslip
    const firstId = listRes.body[0].payrollId;
    const detailRes = await agent.get(`/api/faculty/${FACULTY_ID}/payroll/payslips/${firstId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.payrollId).toBe(firstId);
    expect(detailRes.body.netSalary).toBeDefined();

    // 9c. Salary structure
    const structRes = await agent.get(`/api/faculty/${FACULTY_ID}/payroll/salary-structure`);
    expect(structRes.status).toBe(200);
    expect(Array.isArray(structRes.body)).toBe(true);
    expect(structRes.body[0].basicSalary).toBeDefined();
  });

  it('10. Profile API: GET profile and PUT contact mobile number', async () => {
    const profRes = await agent.get(`/api/faculty/${FACULTY_ID}`);
    expect(profRes.status).toBe(200);
    expect(profRes.body.facultyId).toBe(FACULTY_ID);
    const originalMobile = profRes.body.mobileNumber;
    originalMobileBeforeTest = originalMobile;

    const testMobile = '9876543210';
    const updateRes = await agent.put(`/api/faculty/${FACULTY_ID}/profile`).set('X-CSRF-Token', csrfToken).send({
      mobileNumber: testMobile,
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);
    expect(updateRes.body.mobileNumber).toBe(testMobile);

    // Revert back
    await agent.put(`/api/faculty/${FACULTY_ID}/profile`).set('X-CSRF-Token', csrfToken).send({
      mobileNumber: originalMobile,
    });
  });

  it('11. Grievance API: GET grievances and POST raise new grievance', async () => {
    const listBefore = await agent.get(`/api/faculty/${FACULTY_ID}/grievance`);
    expect(listBefore.status).toBe(200);
    expect(Array.isArray(listBefore.body)).toBe(true);

    const postRes = await agent.post(`/api/faculty/${FACULTY_ID}/grievance`).set('X-CSRF-Token', csrfToken).send({
      subject: '[Test] API Grievance Subject',
      category: 'Infrastructure',
      description: 'Projector in classroom needs servicing',
    });
    if (postRes.status !== 201) console.error('Grievance post error:', postRes.body);
    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.grievanceId).toBeDefined();
    testGrievanceId = postRes.body.grievanceId;

    const listAfter = await agent.get(`/api/faculty/${FACULTY_ID}/grievance`);
    expect(listAfter.status).toBe(200);
    const found = listAfter.body.find((g: { subject: string }) => g.subject.includes('[Test] API Grievance Subject'));
    expect(found).toBeDefined();
  });

  it('12. Mark Attendance API: POST /api/faculty/:id/attendance/sessions submits records', async () => {
    const coursesRes = await agent.get(`/api/faculty/${FACULTY_ID}/courses`);
    expect(coursesRes.status).toBe(200);
    const assignmentId = coursesRes.body[0]?.courseOfferingId;
    expect(assignmentId).toBeDefined();

    const rosterRes = await agent.get(`/api/faculty/${FACULTY_ID}/courses/${assignmentId}/students`);
    expect(rosterRes.status).toBe(200);
    expect(Array.isArray(rosterRes.body)).toBe(true);

    const dateRes = await pool!.query<{ session_date: string }>(`
      SELECT to_char(session_day, 'YYYY-MM-DD') AS session_date
      FROM teaching_assignment ta
      JOIN academic_session term ON term.session_id = ta.academic_session_id
      CROSS JOIN LATERAL generate_series(term.start_date::timestamp, term.end_date::timestamp, interval '1 day') AS dates(session_day)
      WHERE ta.assignment_id = $1
        AND NOT EXISTS (SELECT 1 FROM attendance_session s WHERE s.assignment_id = ta.assignment_id AND s.session_date = session_day::date)
      ORDER BY session_day
      LIMIT 1`, [assignmentId]);
    expect(dateRes.rows[0]).toBeDefined();
    const testSessionDate = dateRes.rows[0]!.session_date;

    const postAttRes = await agent.post(`/api/faculty/${FACULTY_ID}/attendance/sessions`).set('X-CSRF-Token', csrfToken).send({
      courseOfferingId: assignmentId,
      sessionDate: testSessionDate,
      startTime: '10:00',
      endTime: '11:00',
      topic: 'API integration and verification',
      records: rosterRes.body.slice(0, 3).map((s: { studentId: number }, i: number) => ({
        studentId: s.studentId,
        attendanceStatus: i === 0 ? 'ABSENT' : 'PRESENT',
      })),
    });
    testAttendanceSessionId = postAttRes.body.attendanceSessionId;
    expect(postAttRes.status).toBe(200);
    expect(postAttRes.body.success).toBe(true);
    expect(postAttRes.body.attendanceSessionId).toBeDefined();
  });
});
