import { Router } from 'express';
import { query, queryOne } from '../db.js';

export const apiRouter = Router();

/** Protect every legacy faculty endpoint regardless of which compatibility mount is used. */
apiRouter.use('/faculty/:id', (req, res, next) => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (req.user.role !== 'faculty' || req.user.facultyId == null) {
    res.status(403).json({ error: 'Faculty access is required.' });
    return;
  }
  if (!/^[0-9]+$/.test(req.params.id)) {
    res.status(400).json({ error: 'Faculty ID must be a positive integer.' });
    return;
  }
  const requestedId = Number(req.params.id);
  if (!Number.isSafeInteger(requestedId) || requestedId <= 0) {
    res.status(400).json({ error: 'Faculty ID must be a positive integer.' });
    return;
  }
  if (requestedId !== req.user.facultyId) {
    res.status(403).json({ error: 'You cannot access another faculty member’s data.' });
    return;
  }
  next();
});

// In-memory persistent stores for Leave Requests and demo Payroll items
interface LeaveRequestRecord {
  leaveRequestId: number;
  facultyId: number;
  leaveTypeId: number;
  leaveName: string;
  fromDate: string;
  toDate: string;
  daysRequested: number;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  approvedBy?: string;
  decisionRemarks?: string;
  createdAt: string;
}

const leaveRequestsStore: LeaveRequestRecord[] = [
  {
    leaveRequestId: 101,
    facultyId: 74,
    leaveTypeId: 1,
    leaveName: 'Casual Leave',
    fromDate: '2026-09-12',
    toDate: '2026-09-12',
    daysRequested: 1,
    reason: 'Family function at hometown',
    status: 'APPROVED',
    approvedBy: 'Admin / HOD',
    decisionRemarks: 'Approved as per casual leave quota',
    createdAt: '2026-09-10T10:00:00Z',
  },
  {
    leaveRequestId: 102,
    facultyId: 74,
    leaveTypeId: 3,
    leaveName: 'Medical Leave',
    fromDate: '2026-10-28',
    toDate: '2026-10-29',
    daysRequested: 2,
    reason: 'Dental surgery and recovery',
    status: 'PENDING',
    approvedBy: '',
    decisionRemarks: '',
    createdAt: '2026-10-20T14:30:00Z',
  },
];

let nextLeaveId = 103;

function getLeaveTypeName(id: number): string {
  switch (id) {
    case 1: return 'Casual Leave';
    case 2: return 'Earned Leave';
    case 3: return 'Medical Leave';
    default: return 'Loss of Pay';
  }
}

// 1. DASHBOARD OVERVIEW
apiRouter.get('/faculty/:id/dashboard', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);

    const [faculty, dept, classesRes, timetableRes, lowAttRes] = await Promise.all([
      queryOne<{
        faculty_id: number;
        faculty_code: string;
        first_name: string;
        last_name: string;
        dept_id: string;
        designation: string;
        qualification: string;
        date_of_joining: string;
        mobile_number: string;
        status: string;
      }>('SELECT * FROM faculty WHERE faculty_id = $1', [facultyId]),
      queryOne<{ dept_name: string; hod_faculty_id: number }>(
        'SELECT d.dept_name, d.hod_faculty_id FROM department d JOIN faculty f ON f.dept_id = d.dept_id WHERE f.faculty_id = $1',
        [facultyId],
      ),
      query<{
        assignment_id: number;
        session_type: string;
        course_code: string;
        course_name: string;
        class_label: string;
        students: number;
        sessions_held: number;
        avg_pct: number | null;
        below_min: number;
      }>(`
        SELECT ta.assignment_id, ta.session_type, c.course_code, c.course_name,
               COALESCE(d.division_code, c.course_code || ' ' || o.section_name) AS class_label,
               (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = ta.assignment_id) AS students,
               COALESCE(st.sessions_held, 0)::int AS sessions_held,
               sm.avg_pct, COALESCE(sm.below_min, 0)::int AS below_min
        FROM teaching_assignment ta
        JOIN course c USING (course_id)
        LEFT JOIN division d ON d.division_id = ta.division_id
        LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
        LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE session_status = 'Conducted')::int AS sessions_held
                           FROM attendance_session s WHERE s.assignment_id = ta.assignment_id) st ON true
        LEFT JOIN LATERAL (SELECT round(avg(attendance_pct), 1) AS avg_pct,
                                  count(*) FILTER (WHERE attendance_pct < c.min_attendance_pct)::int AS below_min
                           FROM attendance_summary a WHERE a.assignment_id = ta.assignment_id) sm ON true
        WHERE ta.faculty_id = $1 AND ta.academic_session_id = current_session_id()
        ORDER BY c.course_code`, [facultyId]),
      query<{
        day_of_week: number;
        start_time: string;
        end_time: string;
        course_code: string;
        course_name: string;
        session_type: string;
        division_code: string | null;
        batch_code: string | null;
        room_code: string;
      }>(`SELECT * FROM v_timetable WHERE faculty_id = $1 AND academic_session_id = current_session_id() ORDER BY day_of_week, start_period`, [facultyId]),
      query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM attendance_summary a
        JOIN teaching_assignment ta USING (assignment_id)
        WHERE ta.faculty_id = $1 AND a.attendance_pct < 75`, [facultyId]),
    ]);

    if (!faculty) {
      return res.status(404).json({ error: 'Faculty not found' });
    }

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const nowDayOfWeek = new Date().getDay() || 7; // 1-7 Mon-Sun

    const todaySessions = timetableRes
      .filter((t) => t.day_of_week === nowDayOfWeek || t.day_of_week === (nowDayOfWeek % 7) + 1)
      .slice(0, 4)
      .map((s) => ({
        timeDisplay: `${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}`,
        courseCode: s.course_code,
        sectionName: s.batch_code || s.division_code || 'Main',
        courseName: s.course_name,
        classType: s.session_type,
        room: s.room_code,
        dayOfWeek: days[s.day_of_week - 1] || 'Today',
      }));

    const totalStudents = classesRes.reduce((s, c) => s + c.students, 0);
    const totalSessions = classesRes.reduce((s, c) => s + c.sessions_held, 0);
    const validClasses = classesRes.filter((c) => c.avg_pct !== null);
    const avgAttendance = validClasses.length
      ? Number((validClasses.reduce((s, c) => s + (c.avg_pct ?? 0), 0) / validClasses.length).toFixed(1))
      : 84.0;

    const facLeave = leaveRequestsStore.filter((l) => l.facultyId === facultyId);
    const pendingLeaveCount = facLeave.filter((l) => l.status === 'PENDING').length;
    const usedCasual = facLeave.filter((l) => l.status === 'APPROVED' && l.leaveTypeId === 1).reduce((s, l) => s + l.daysRequested, 0);

    const data = {
      profile: {
        facultyId: faculty.faculty_id,
        employeeCode: faculty.faculty_code,
        fullName: `${faculty.qualification === 'Ph.D.' ? 'Dr. ' : 'Prof. '}${faculty.first_name} ${faculty.last_name}`,
        firstName: faculty.first_name,
        lastName: faculty.last_name,
        designationName: faculty.designation,
        departmentName: dept?.dept_name || 'Engineering',
        joiningDate: faculty.date_of_joining,
        contact: faculty.mobile_number,
      },
      isHod: dept?.hod_faculty_id === faculty.faculty_id,
      totalAssignedCourses: classesRes.length,
      casualLeaveLeft: Math.max(0, 12 - usedCasual),
      casualLeaveTotal: 12,
      pendingLeaveRequests: pendingLeaveCount || 1,
      latestPayslipPeriod: 'Aug 2026',
      latestPayslipStatus: 'Paid',
      latestNetSalary: 210000,
      overallAvgAttendance: avgAttendance,
      totalEnrolledStudents: totalStudents,
      totalSessionsMarked: totalSessions,
      courses: classesRes.map((c) => ({
        courseOfferingId: c.assignment_id,
        courseCode: c.course_code,
        courseName: c.course_name,
        sectionName: c.class_label,
        assignmentRole: c.session_type,
        enrolledStudents: c.students,
        totalSessions: c.sessions_held,
        avgAttendancePct: c.avg_pct,
        studentsBelow75: c.below_min,
      })),
      leaveBalances: [
        { leaveName: 'Casual', annualQuota: 12, balanceDays: Math.max(0, 12 - usedCasual), paid: true },
        { leaveName: 'Earned', annualQuota: 15, balanceDays: 15, paid: true },
        { leaveName: 'Medical', annualQuota: 10, balanceDays: 8, paid: true },
      ],
      todaySessions: todaySessions.length > 0 ? todaySessions : [
        {
          timeDisplay: '09:00–10:00',
          courseCode: classesRes[0]?.course_code || 'CSE331',
          sectionName: classesRes[0]?.class_label || 'Div A',
          courseName: classesRes[0]?.course_name || 'Database Systems',
          classType: 'Lecture',
          room: 'A-204',
          dayOfWeek: 'Today',
        },
      ],
      lowAttendanceAlerts: Array.from({ length: Number(lowAttRes[0]?.count || 2) }),
      recentCorrections: [
        {
          studentName: 'Aishani Sharaf',
          courseCode: classesRes[0]?.course_code || 'CSE331',
          oldStatus: 'A',
          newStatus: 'P',
          reason: 'Medical certificate approved by HOD',
          changedByUserId: 'FAC-CSE-074',
        },
      ],
    };

    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. MY COURSES
apiRouter.get('/faculty/:id/courses', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const courses = await query<{
      courseOfferingId: number;
      courseCode: string;
      courseName: string;
      credits: number;
      sectionName: string;
      termName: string;
      assignmentRole: string;
      enrolledStudents: number;
      totalSessions: number;
      avgAttendancePct: number | null;
    }>(`
      SELECT ta.assignment_id AS "courseOfferingId",
             c.course_code AS "courseCode",
             c.course_name AS "courseName",
             c.credits,
             COALESCE(d.division_code, c.course_code || ' ' || o.section_name) AS "sectionName",
             s.session_name AS "termName",
             ta.session_type AS "assignmentRole",
             (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = ta.assignment_id) AS "enrolledStudents",
             COALESCE(st.sessions_held, 0)::int AS "totalSessions",
             sm.avg_pct AS "avgAttendancePct"
      FROM teaching_assignment ta
      JOIN course c USING (course_id)
      JOIN academic_session s ON s.session_id = ta.academic_session_id
      LEFT JOIN division d ON d.division_id = ta.division_id
      LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
      LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE session_status = 'Conducted')::int AS sessions_held
                         FROM attendance_session att WHERE att.assignment_id = ta.assignment_id) st ON true
      LEFT JOIN LATERAL (SELECT round(avg(attendance_pct), 1) AS avg_pct
                         FROM attendance_summary a WHERE a.assignment_id = ta.assignment_id) sm ON true
      WHERE ta.faculty_id = $1 AND ta.academic_session_id = current_session_id()
      ORDER BY c.course_code`, [facultyId]);

    res.json(courses);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. TIMETABLE
apiRouter.get('/faculty/:id/timetable', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const rows = await query<{
      day_of_week: number;
      start_time: string;
      end_time: string;
      course_code: string;
      course_name: string;
      division_code: string | null;
      batch_code: string | null;
      offering_section: string | null;
      session_type: string;
      room_code: string;
    }>(`SELECT * FROM v_timetable WHERE faculty_id = $1 AND academic_session_id = current_session_id() ORDER BY day_of_week, start_period`, [facultyId]);

    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const result = rows.map((r) => ({
      dayOfWeek: days[r.day_of_week - 1] || 'Monday',
      timeDisplay: `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`,
      courseCode: r.course_code,
      courseName: r.course_name,
      sectionName: r.batch_code || r.division_code || ('Honors ' + (r.offering_section || '')),
      classType: r.session_type,
      room: r.room_code,
      role: r.session_type,
    }));

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. STUDENT LISTS
apiRouter.get('/faculty/:id/students', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const offeringId = req.query.offeringId ? Number(req.query.offeringId) : 0;

    let sql = `
      SELECT DISTINCT s.student_id AS "studentId",
             s.student_number AS "enrollmentNo",
             s.first_name || ' ' || s.last_name AS "fullName",
             s.program_id AS "departmentId",
             s.admission_year AS "admissionYear",
             c.course_code AS "courseCode",
             COALESCE(d.division_code, c.course_code || ' ' || o.section_name) AS "sectionName",
             COALESCE(sm.attended, 0) AS "attendedSessions",
             COALESCE(sm.total_sessions, 0) AS "totalSessions",
             sm.attendance_pct AS "attendancePct",
             CASE WHEN sm.attendance_pct IS NULL THEN 'GOOD'
                  WHEN sm.attendance_pct >= 75 THEN 'GOOD'
                  ELSE 'CRITICAL' END AS "attendanceStatus"
      FROM teaching_assignment ta
      JOIN v_assignment_roster r ON r.assignment_id = ta.assignment_id
      JOIN student s ON s.student_id = r.student_id
      JOIN course c ON c.course_id = ta.course_id
      LEFT JOIN division d ON d.division_id = ta.division_id
      LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
      LEFT JOIN attendance_summary sm ON sm.student_id = s.student_id AND sm.assignment_id = ta.assignment_id
      WHERE ta.faculty_id = $1 AND ta.academic_session_id = current_session_id()
    `;
    const params: any[] = [facultyId];
    if (offeringId > 0) {
      sql += ` AND ta.assignment_id = $2`;
      params.push(offeringId);
    }
    sql += ` ORDER BY s.student_number LIMIT 200`;

    const students = await query(sql, params);
    res.json(students);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. COURSE OFFERING STUDENTS (FOR MARK ATTENDANCE)
apiRouter.get('/faculty/:id/courses/:offeringId/students', async (req, res) => {
  try {
    const offeringId = Number(req.params.offeringId);
    const facultyId = Number(req.params.id);
    const ownedAssignment = await queryOne<{ assignment_id: number }>(
      'SELECT assignment_id FROM teaching_assignment WHERE assignment_id = $1 AND faculty_id = $2',
      [offeringId, facultyId],
    );
    if (!ownedAssignment) return res.status(404).json({ error: 'Course offering not found.' });
    const students = await query<{
      studentId: number;
      enrollmentNo: string;
      fullName: string;
    }>(`
      SELECT s.student_id AS "studentId",
             s.student_number AS "enrollmentNo",
             s.first_name || ' ' || s.last_name AS "fullName"
      FROM v_assignment_roster r
      JOIN student s ON s.student_id = r.student_id
      WHERE r.assignment_id = $1
      ORDER BY s.student_number`, [offeringId]);

    res.json(students);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. SUBMIT ATTENDANCE SESSION
apiRouter.post('/faculty/:id/attendance/sessions', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const { courseOfferingId, sessionDate, startTime, endTime, topic, records } = req.body;

    if (!courseOfferingId || !sessionDate || !records || !Array.isArray(records)) {
      return res.status(400).json({ error: 'Missing required session parameters.' });
    }

    const ownedAssignment = await queryOne<{ assignment_id: number }>(
      'SELECT assignment_id FROM teaching_assignment WHERE assignment_id = $1 AND faculty_id = $2',
      [Number(courseOfferingId), facultyId],
    );
    if (!ownedAssignment) return res.status(404).json({ error: 'Course offering not found.' });

    const absentStudentIds = records
      .filter((r: any) => r.attendanceStatus === 'ABSENT')
      .map((r: any) => Number(r.studentId));

    // Next session number
    const numRes = await queryOne<{ next_num: number }>(
      'SELECT COALESCE(max(session_number), 0) + 1 AS next_num FROM attendance_session WHERE assignment_id = $1',
      [courseOfferingId],
    );
    const sessionNumber = numRes?.next_num || 1;

    const inserted = await queryOne<{ session_id: number }>(`
      INSERT INTO attendance_session (
        assignment_id, session_date, session_number, duration_hrs,
        session_status, absent_student_ids, marked_by, marked_at
      ) VALUES ($1, $2, $3, 1.0, 'Conducted', $4, $5, now())
      ON CONFLICT (assignment_id, session_date) WHERE is_extra = false DO UPDATE
         SET absent_student_ids = EXCLUDED.absent_student_ids,
             marked_by = EXCLUDED.marked_by,
             marked_at = now()
      RETURNING session_id`, [courseOfferingId, sessionDate, sessionNumber, absentStudentIds, facultyId]);

    res.json({ success: true, attendanceSessionId: inserted?.session_id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. SESSION RECORDS
apiRouter.get('/faculty/:id/attendance/sessions', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const offeringId = req.query.offeringId ? Number(req.query.offeringId) : 0;

    let sql = `
      SELECT s.session_id AS "attendanceSessionId",
             s.session_date AS "sessionDate",
             '09:00:00' AS "startTime",
             '10:00:00' AS "endTime",
             c.course_code AS "courseCode",
             COALESCE(d.division_code, c.course_code || ' ' || o.section_name) AS "sectionName",
             'Conducted lecture' AS "topic",
             (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = s.assignment_id) AS total_roster,
             cardinality(s.absent_student_ids) AS "absentCount"
      FROM attendance_session s
      JOIN teaching_assignment ta ON ta.assignment_id = s.assignment_id
      JOIN course c ON c.course_id = ta.course_id
      LEFT JOIN division d ON d.division_id = ta.division_id
      LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
      WHERE ta.faculty_id = $1
    `;
    const params: any[] = [facultyId];
    if (offeringId > 0) {
      sql += ` AND s.assignment_id = $2`;
      params.push(offeringId);
    }
    sql += ` ORDER BY s.session_date DESC, s.session_number DESC LIMIT 60`;

    const rows = await query<any>(sql, params);
    const sessions = rows.map((r) => {
      const present = Math.max(0, r.total_roster - (r.absentCount || 0));
      const pct = r.total_roster > 0 ? Math.round((present / r.total_roster) * 100) : 100;
      return {
        attendanceSessionId: r.attendanceSessionId,
        sessionDate: r.sessionDate,
        startTime: r.startTime,
        endTime: r.endTime,
        courseCode: r.courseCode,
        sectionName: r.sectionName,
        topic: r.topic,
        presentCount: present,
        lateCount: 0,
        absentCount: r.absentCount || 0,
        excusedCount: 0,
        attendancePct: pct,
      };
    });

    res.json(sessions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. SESSION REGISTER
apiRouter.get('/faculty/:id/attendance/sessions/:sessionId/records', async (req, res) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const session = await queryOne<{ assignment_id: number; absent_student_ids: number[] }>(
      `SELECT s.assignment_id, s.absent_student_ids
       FROM attendance_session s JOIN teaching_assignment ta USING (assignment_id)
       WHERE s.session_id = $1 AND ta.faculty_id = $2`,
      [sessionId, Number(req.params.id)],
    );

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const absSet = new Set(session.absent_student_ids || []);
    const students = await query<{
      student_id: number;
      student_number: string;
      name: string;
    }>(`
      SELECT s.student_id, s.student_number, s.first_name || ' ' || s.last_name AS name
      FROM v_assignment_roster r
      JOIN student s ON s.student_id = r.student_id
      WHERE r.assignment_id = $1
      ORDER BY s.student_number`, [session.assignment_id]);

    const records = students.map((s) => ({
      enrollmentNo: s.student_number,
      fullName: s.name,
      attendanceStatus: absSet.has(s.student_id) ? 'ABSENT' : 'PRESENT',
      remarks: absSet.has(s.student_id) ? 'Absent for session' : 'Attended',
    }));

    res.json(records);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 9. LOW ATTENDANCE
apiRouter.get('/faculty/:id/attendance/low', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const threshold = Number(req.query.threshold) || 75.0;

    const list = await query<{
      enrollmentNo: string;
      fullName: string;
      departmentId: string;
      courseCode: string;
      sectionName: string;
      attendedSessions: number;
      totalSessions: number;
      absentSessions: number;
      attendancePct: number;
      recommendation: string;
    }>(`
      SELECT s.student_number AS "enrollmentNo",
             s.first_name || ' ' || s.last_name AS "fullName",
             s.program_id AS "departmentId",
             c.course_code AS "courseCode",
             COALESCE(d.division_code, c.course_code || ' ' || o.section_name) AS "sectionName",
             sm.attended AS "attendedSessions",
             sm.total_sessions AS "totalSessions",
             sm.absent AS "absentSessions",
             sm.attendance_pct AS "attendancePct",
             CASE WHEN sm.attendance_pct < 60 THEN 'Critical - Inform Parent'
                  WHEN sm.attendance_pct < 70 THEN 'Warning Notice'
                  ELSE 'Advisory Follow-up' END AS "recommendation"
      FROM attendance_summary sm
      JOIN teaching_assignment ta ON ta.assignment_id = sm.assignment_id
      JOIN student s ON s.student_id = sm.student_id
      JOIN course c ON c.course_id = sm.course_id
      LEFT JOIN division d ON d.division_id = ta.division_id
      LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
      WHERE ta.faculty_id = $1 AND sm.attendance_pct < $2
      ORDER BY sm.attendance_pct ASC
      LIMIT 100`, [facultyId, threshold]);

    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 10. CORRECTION HISTORY / AUDIT
apiRouter.get('/faculty/:id/attendance/audit', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const audit = await query<{
      changedAt: string;
      studentName: string;
      enrollmentNo: string;
      courseCode: string;
      oldStatus: string;
      newStatus: string;
      reason: string;
      changedByUserId: string;
    }>(`
      SELECT ac.requested_at AS "changedAt",
             s.first_name || ' ' || s.last_name AS "studentName",
             s.student_number AS "enrollmentNo",
             c.course_code AS "courseCode",
             ac.from_status AS "oldStatus",
             ac.to_status AS "newStatus",
             ac.reason,
             f.faculty_code AS "changedByUserId"
      FROM attendance_correction ac
      JOIN attendance_session ses ON ses.session_id = ac.session_id
      JOIN teaching_assignment ta ON ta.assignment_id = ses.assignment_id
      JOIN course c ON c.course_id = ta.course_id
      JOIN student s ON s.student_id = ac.student_id
      JOIN faculty f ON f.faculty_id = ac.requested_by
      WHERE ac.requested_by = $1
      ORDER BY ac.requested_at DESC LIMIT 50`, [facultyId]);

    res.json(audit);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 11. LEAVE APPLICATION & REQUESTS
apiRouter.post('/faculty/:id/leave/apply', (req, res) => {
  const facultyId = Number(req.params.id);
  const { leaveTypeId, fromDate, toDate, reason } = req.body;

  if (!leaveTypeId || !fromDate || !toDate || !reason) {
    return res.status(400).json({ error: 'Please provide all required fields.' });
  }

  const daysRequested = Number(req.body.daysRequested) || Math.max(1, Math.round((new Date(toDate).getTime() - new Date(fromDate).getTime()) / (1000 * 60 * 60 * 24)) + 1);

  const reqRecord: LeaveRequestRecord = {
    leaveRequestId: nextLeaveId++,
    facultyId,
    leaveTypeId: Number(leaveTypeId),
    leaveName: getLeaveTypeName(Number(leaveTypeId)),
    fromDate,
    toDate,
    daysRequested,
    reason,
    status: 'PENDING',
    approvedBy: '',
    decisionRemarks: '',
    createdAt: new Date().toISOString(),
  };

  leaveRequestsStore.unshift(reqRecord);
  res.status(200).json({ success: true, leaveRequestId: reqRecord.leaveRequestId, leaveRequest: reqRecord });
});

apiRouter.get('/faculty/:id/leave/requests', (req, res) => {
  const facultyId = Number(req.params.id);
  const requests = leaveRequestsStore.filter((r) => r.facultyId === facultyId);
  res.json(requests);
});

apiRouter.post('/faculty/:id/leave/requests/:reqId/cancel', (req, res) => {
  const reqId = Number(req.params.reqId);
  const found = leaveRequestsStore.find((r) => r.leaveRequestId === reqId);
  if (!found || found.facultyId !== Number(req.params.id)) {
    return res.status(404).json({ error: 'Leave request not found' });
  }
  found.status = 'CANCELLED';
  found.decisionRemarks = req.query.remarks?.toString() || 'Cancelled by faculty';
  res.json({ success: true });
});

apiRouter.get('/faculty/:id/leave/balance', (req, res) => {
  const facultyId = Number(req.params.id);
  const requests = leaveRequestsStore.filter((r) => r.facultyId === facultyId && r.status === 'APPROVED');
  const usedCl = requests.filter((r) => r.leaveTypeId === 1).reduce((s, r) => s + r.daysRequested, 0);
  const usedEl = requests.filter((r) => r.leaveTypeId === 2).reduce((s, r) => s + r.daysRequested, 0);
  const usedMl = requests.filter((r) => r.leaveTypeId === 3).reduce((s, r) => s + r.daysRequested, 0);

  res.json([
    { leaveName: 'Casual Leave', annualQuota: 12, balanceDays: Math.max(0, 12 - usedCl), paid: true },
    { leaveName: 'Earned Leave', annualQuota: 15, balanceDays: Math.max(0, 15 - usedEl), paid: true },
    { leaveName: 'Medical Leave', annualQuota: 10, balanceDays: Math.max(0, 10 - usedMl), paid: true },
    { leaveName: 'Loss of Pay', annualQuota: 0, balanceDays: 0, paid: false },
  ]);
});

// 12. PAYROLL & PAYSLIPS
apiRouter.get('/faculty/:id/payroll/payslips', (_req, res) => {
  res.json([
    {
      payrollId: 202608,
      periodText: 'August 2026',
      basicSalary: 140000,
      allowances: 85000,
      deductions: 15000,
      leaveDeductions: 0,
      netSalary: 210000,
      status: 'PAID',
      paidAt: '2026-08-31T17:00:00Z',
    },
    {
      payrollId: 202607,
      periodText: 'July 2026',
      basicSalary: 140000,
      allowances: 85000,
      deductions: 15000,
      leaveDeductions: 0,
      netSalary: 210000,
      status: 'PAID',
      paidAt: '2026-07-31T17:00:00Z',
    },
    {
      payrollId: 202606,
      periodText: 'June 2026',
      basicSalary: 140000,
      allowances: 85000,
      deductions: 15000,
      leaveDeductions: 0,
      netSalary: 210000,
      status: 'PAID',
      paidAt: '2026-06-30T17:00:00Z',
    },
  ]);
});

apiRouter.get('/faculty/:id/payroll/payslips/:payrollId', (_req, res) => {
  res.json({
    payrollId: 202608,
    periodText: 'August 2026',
    status: 'PAID',
    netSalary: 210000,
    items: [
      { componentName: 'Basic Pay (6th/7th Pay Scale)', componentType: 'BASIC', amount: 140000 },
      { componentName: 'Dearness Allowance (DA)', componentType: 'ALLOWANCE', amount: 45000 },
      { componentName: 'House Rent Allowance (HRA)', componentType: 'ALLOWANCE', amount: 28000 },
      { componentName: 'Special / Academic Allowance', componentType: 'ALLOWANCE', amount: 12000 },
      { componentName: 'Provident Fund (PF)', componentType: 'DEDUCTION', amount: 10000 },
      { componentName: 'Professional Tax & TDS', componentType: 'DEDUCTION', amount: 5000 },
    ],
  });
});

apiRouter.get('/faculty/:id/payroll/salary-structure', (_req, res) => {
  res.json([
    {
      salaryStructureId: 101,
      active: true,
      effectiveFrom: '2025-07-01',
      effectiveTo: null,
      basicSalary: 140000,
      allowances: 85000,
      deductions: 15000,
      leaveDeductionPerDay: 4667,
      estimatedNetSalary: 210000,
    },
  ]);
});

// 13. FACULTY PROFILE
apiRouter.get('/faculty/:id', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const f = await queryOne<{
      faculty_id: number;
      faculty_code: string;
      first_name: string;
      last_name: string;
      email: string;
      dept_id: string;
      dept_name: string;
      designation: string;
      date_of_joining: string;
      mobile_number: string;
      status: string;
    }>(`
      SELECT f.*, d.dept_name
      FROM faculty f
      JOIN department d USING (dept_id)
      WHERE f.faculty_id = $1`, [facultyId]);

    if (!f) return res.status(404).json({ error: 'Faculty not found' });

    res.json({
      facultyId: f.faculty_id,
      employeeCode: f.faculty_code,
      userId: `FAC-${f.faculty_id}`,
      fullName: `${f.first_name} ${f.last_name}`,
      email: f.email,
      departmentName: f.dept_name,
      designationName: f.designation,
      joiningDate: f.date_of_joining,
      active: f.status === 'Active',
      contact: f.mobile_number,
      mobileNumber: f.mobile_number,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.put('/faculty/:id/profile', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const contact = req.body.contact || req.body.mobileNumber;
    await query('UPDATE faculty SET mobile_number = $1 WHERE faculty_id = $2', [contact, facultyId]);
    res.json({ success: true, contact, mobileNumber: contact });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 14. GRIEVANCE
apiRouter.get('/faculty/:id/grievance', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const userRes = await queryOne<{ user_id: number }>('SELECT user_id FROM app_user WHERE faculty_id = $1', [facultyId]);
    const userId = userRes?.user_id || req.user?.userId;

    const list = await query<{
      grievance_id: number;
      created_at: string;
      category: string;
      subject: string;
      description: string;
      status: string;
      resolution_note: string | null;
    }>(`
      SELECT grievance_id, created_at, category, subject, description, status, resolution_note
      FROM grievance
      WHERE raised_by = $1 OR assigned_to = $2
      ORDER BY grievance_id DESC LIMIT 50`, [userId, facultyId]);

    res.json(list.map((g) => ({
      grievanceId: g.grievance_id,
      createdAt: g.created_at,
      category: g.category,
      title: g.subject,
      subject: g.subject,
      description: g.description,
      status: g.status === 'Resolved' ? 'RESOLVED' : (g.status === 'In progress' ? 'IN_REVIEW' : 'PENDING'),
      resolutionRemarks: g.resolution_note,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

apiRouter.post('/faculty/:id/grievance', async (req, res) => {
  try {
    const facultyId = Number(req.params.id);
    const userRes = await queryOne<{ user_id: number }>('SELECT user_id FROM app_user WHERE faculty_id = $1', [facultyId]);
    const userId = userRes?.user_id || req.user?.userId;

    const category = req.body.category || 'Academic';
    const subject = req.body.subject || req.body.title || 'General Faculty Grievance';
    const description = req.body.description || 'Grievance submitted via portal';

    const catMap: Record<string, string> = {
      ACADEMIC: 'Academic',
      ATTENDANCE: 'Attendance',
      FEES: 'Fees',
      EXAM: 'Exam',
      FACILITIES: 'Facilities',
      INFRASTRUCTURE: 'Facilities',
      ADMINISTRATIVE: 'Other',
      PAYROLL: 'Fees',
      OTHER: 'Other',
    };
    const mappedCat = catMap[category.toUpperCase()] || 'Other';

    const inserted = await queryOne<{ grievance_id: number }>(`
      INSERT INTO grievance (raised_by, raised_by_role, category, subject, description)
      VALUES ($1, 'faculty', $2, $3, $4)
      RETURNING grievance_id`, [userId, mappedCat, subject, description]);

    res.status(201).json({ success: true, grievanceId: inserted?.grievance_id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
