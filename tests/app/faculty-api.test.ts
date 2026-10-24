import { beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const FACULTY = 'FAC-CSE-074';
const FACULTY_ID = 74;

const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };

describe.skipIf(!hasAppEnv)('Faculty Dashboard API Endpoints', () => {
  const app = createApp!();
  type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
  let agent: Agent;

  beforeAll(async () => {
    agent = (await signIn(app, FACULTY, DEMO)).agent;
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
    const applyRes = await agent.post(`/api/faculty/${FACULTY_ID}/leave/apply`).send({
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
    const cancelRes = await agent.post(`/api/faculty/${FACULTY_ID}/leave/requests/${newReqId}/cancel`);
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

    const testMobile = '9876543210';
    const updateRes = await agent.put(`/api/faculty/${FACULTY_ID}/profile`).send({
      mobileNumber: testMobile,
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.success).toBe(true);
    expect(updateRes.body.mobileNumber).toBe(testMobile);

    // Revert back
    await agent.put(`/api/faculty/${FACULTY_ID}/profile`).send({
      mobileNumber: originalMobile,
    });
  });

  it('11. Grievance API: GET grievances and POST raise new grievance', async () => {
    const listBefore = await agent.get(`/api/faculty/${FACULTY_ID}/grievance`);
    expect(listBefore.status).toBe(200);
    expect(Array.isArray(listBefore.body)).toBe(true);

    const postRes = await agent.post(`/api/faculty/${FACULTY_ID}/grievance`).send({
      subject: '[Test] API Grievance Subject',
      category: 'Infrastructure',
      description: 'Projector in classroom needs servicing',
    });
    if (postRes.status !== 201) console.error('Grievance post error:', postRes.body);
    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.grievanceId).toBeDefined();

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

    const postAttRes = await agent.post(`/api/faculty/${FACULTY_ID}/attendance/sessions`).send({
      courseOfferingId: assignmentId,
      sessionDate: '2026-10-23',
      startTime: '10:00',
      endTime: '11:00',
      topic: 'API integration and verification',
      records: rosterRes.body.slice(0, 3).map((s: { studentId: number }, i: number) => ({
        studentId: s.studentId,
        attendanceStatus: i === 0 ? 'ABSENT' : 'PRESENT',
      })),
    });
    if (postAttRes.status !== 200) console.error('Attendance submit error:', postAttRes.body);
    expect(postAttRes.status).toBe(200);
    expect(postAttRes.body.success).toBe(true);
    expect(postAttRes.body.attendanceSessionId).toBeDefined();
  });
});
