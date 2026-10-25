import { Router } from 'express';
import { isoWeekday, termProgress, todayIso } from '../lib/format.js';
import { forbidden, notFound } from '../lib/http-error.js';
import {
  getAssignment, getFacultyClasses, getFacultyProfile, getRoster, teachesStudent,
  getFacultyLeaveBalances, getFacultyLeaveRequests, getFacultyLeaveTypes, submitLeaveRequest,
  cancelLeaveRequest, getFacultySalaryStructure, getFacultyPayslips, getPayslipDetail,
} from '../queries/faculty-queries.js';
import { getFacultyTimetable, getStudentCourses, getStudentProfile, nextClassDay } from '../queries/shared-queries.js';
import { getFacultySyllabusPct, getRecentSessions, getSyllabusSummary, getUnitProgress } from '../queries/syllabus-queries.js';
import { grievanceRouter } from './grievance-routes.js';
import { noticeRouter } from './notice-routes.js';
import { noticeSummary } from '../queries/notice-queries.js';
import { facultyAttendanceRouter } from './faculty-attendance-routes.js';
import { facultyExaminationRouter } from './faculty-examination-routes.js';
import { flash } from '../middleware/auth.js';
import { friendlyDbError } from '../db.js';

export const facultyRouter = Router();
facultyRouter.use('/attendance', facultyAttendanceRouter);
facultyRouter.use('/examination', facultyExaminationRouter);
facultyRouter.use('/grievances', grievanceRouter);
facultyRouter.use('/notices', noticeRouter);

function idParam(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}

facultyRouter.get('/', async (req, res) => {
  const facultyId = req.user!.facultyId!;
  const [profile, classes, timetable, notices, leaveBalances, payslips, leaveRequests] = await Promise.all([
    getFacultyProfile(facultyId), getFacultyClasses(facultyId), getFacultyTimetable(facultyId),
    noticeSummary(req.user!.userId, 4, res.locals.notificationUnreadCount),
    getFacultyLeaveBalances(facultyId),
    getFacultyPayslips(facultyId),
    getFacultyLeaveRequests(facultyId),
  ]);
  if (!profile) throw notFound('Faculty record');

  const withData = classes.filter((c) => c.avg_pct !== null);
  const totalStudents = withData.reduce((s, c) => s + c.students, 0);
  const avgAttendance = totalStudents
    ? withData.reduce((s, c) => s + (c.avg_pct ?? 0) * c.students, 0) / totalStudents : null;
  // one bar per course, averaging its classes weighted by size
  const byCourse = new Map<string, { code: string; name: string; weighted: number; students: number }>();
  for (const c of withData) {
    const e = byCourse.get(c.course_code) ?? { code: c.course_code, name: c.course_name, weighted: 0, students: 0 };
    e.weighted += (c.avg_pct ?? 0) * c.students;
    e.students += c.students;
    byCourse.set(c.course_code, e);
  }
  const session = res.locals.currentSession as { start_date: string; end_date: string } | undefined;
  const today = todayIso();

  res.render('faculty/dashboard', {
    title: 'Dashboard', nav: 'dashboard', profile, classes, notices, noticeBase: '/faculty/notices',
    stats: {
      classes: classes.length,
      weeklyHours: timetable.reduce((h, t) => h + t.periods, 0),
      sessionsHeld: classes.reduce((s, c) => s + c.sessions_held, 0),
      belowMin: classes.reduce((s, c) => s + c.below_min, 0),
      avgAttendance,
    },
    courseBars: [...byCourse.values()].map((e) => ({ ...e, pct: e.weighted / e.students })),
    attention: classes.filter((c) => c.below_min > 0).sort((a, b) => b.below_min - a.below_min).slice(0, 4),
    progress: session ? termProgress(session.start_date, session.end_date, today) : null,
    classDay: nextClassDay(timetable, isoWeekday(today)),
    leaveBalances,
    latestPayslip: payslips[0] || null,
    pendingLeaves: leaveRequests.filter((r) => r.status === 'PENDING').length,
  });
});

facultyRouter.get('/classes', async (req, res) => {
  const classes = await getFacultyClasses(req.user!.facultyId!);
  const syllabus = await getFacultySyllabusPct(req.user!.facultyId!);
  res.render('faculty/classes', { title: 'My classes', nav: 'classes', classes, syllabus });
});

facultyRouter.get('/classes/:id', async (req, res) => {
  const cls = await getAssignment(idParam(req.params.id), req.user!.facultyId!);
  if (!cls) throw notFound('Class');                       // not one of this faculty member's classes
  const roster = await getRoster(cls.assignment_id);
  const filter = req.query.filter === 'below' ? 'below' : 'all';
  res.render('faculty/class-roster', {
    title: `${cls.course_code} · ${cls.class_label}`, nav: 'classes', cls, filter,
    roster: filter === 'below' ? roster.filter((r) => r.attendance_pct !== null && r.attendance_pct < cls.min_attendance_pct) : roster,
    rosterSize: roster.length,
  });
});

// Faculty see an academic view of their own students only (no personal or family details).
facultyRouter.get('/students/:id', async (req, res) => {
  const studentId = idParam(req.params.id);
  if (!(await teachesStudent(req.user!.facultyId!, studentId))) throw forbidden();
  const [profile, courses, classes] = await Promise.all([
    getStudentProfile(studentId), getStudentCourses(studentId), getFacultyClasses(req.user!.facultyId!),
  ]);
  if (!profile) throw notFound('Student');
  const mine = new Set(classes.map((c) => c.course_id));
  res.render('faculty/student', { title: `${profile.first_name} ${profile.last_name}`, nav: 'classes', profile, courses, mine });
});

facultyRouter.get('/profile', async (req, res) => {
  const profile = await getFacultyProfile(req.user!.facultyId!);
  if (!profile) throw notFound('Faculty record');
  res.render('faculty/profile', { title: 'Profile', nav: 'profile', profile });
});

// T3-3: syllabus coverage of one of this faculty member's classes (planned vs delivered lectures per unit).
facultyRouter.get('/classes/:id/syllabus', async (req, res) => {
  const cls = await getAssignment(idParam(req.params.id), req.user!.facultyId!);
  if (!cls) throw notFound('Class');                       // not one of this faculty member's classes
  const [summary, units, recent] = await Promise.all([
    getSyllabusSummary(cls.assignment_id), getUnitProgress(cls.assignment_id), getRecentSessions(cls.assignment_id),
  ]);
  res.render('faculty/syllabus-coverage', {
    title: `Syllabus · ${cls.course_code}`, nav: 'classes', cls, summary, units, recent,
  });
});

// T2: Faculty Leave Management
facultyRouter.get('/leave', async (req, res) => {
  const facultyId = req.user!.facultyId!;
  const [balances, requests, types] = await Promise.all([
    getFacultyLeaveBalances(facultyId),
    getFacultyLeaveRequests(facultyId),
    getFacultyLeaveTypes(),
  ]);
  res.render('faculty/leave', {
    title: 'Leave Management',
    nav: 'leave',
    balances,
    requests,
    types,
  });
});

facultyRouter.post('/leave/apply', async (req, res) => {
  const facultyId = req.user!.facultyId!;
  const leaveTypeId = Number(req.body.leave_type_id);
  const fromDate = String(req.body.from_date || '').trim();
  const toDate = String(req.body.to_date || '').trim();
  const daysRequested = Number(req.body.days_requested);
  const reason = String(req.body.reason || '').trim();

  if (!leaveTypeId || !fromDate || !toDate || !daysRequested || !reason) {
    flash(req, 'error', 'Please fill in all required leave application fields.');
    return res.redirect('/faculty/leave');
  }

  try {
    const reqId = await submitLeaveRequest(facultyId, leaveTypeId, fromDate, toDate, daysRequested, reason);
    flash(req, 'success', `Leave request #${reqId} submitted successfully.`);
  } catch (err: any) {
    flash(req, 'error', friendlyDbError(err) ?? (err.message || 'Could not submit leave application.'));
  }
  res.redirect('/faculty/leave');
});

facultyRouter.post('/leave/cancel/:id', async (req, res) => {
  const reqId = idParam(req.params.id);
  const remarks = String(req.body.remarks || 'Cancelled by faculty').trim();
  try {
    await cancelLeaveRequest(reqId, remarks);
    flash(req, 'success', `Leave request #${reqId} was cancelled.`);
  } catch (err: any) {
    flash(req, 'error', friendlyDbError(err) ?? (err.message || 'Could not cancel leave request.'));
  }
  res.redirect('/faculty/leave');
});

// T2: Faculty Payroll & Payslips
facultyRouter.get('/payroll', async (req, res) => {
  const facultyId = req.user!.facultyId!;
  const [salaryStructures, payslips] = await Promise.all([
    getFacultySalaryStructure(facultyId),
    getFacultyPayslips(facultyId),
  ]);
  const activeStructure = salaryStructures.find((s) => s.is_active) || salaryStructures[0] || null;
  res.render('faculty/payroll', {
    title: 'Payslips & Salary',
    nav: 'payroll',
    activeStructure,
    salaryStructures,
    payslips,
  });
});

facultyRouter.get('/payroll/:id', async (req, res) => {
  const facultyId = req.user!.facultyId!;
  const payrollId = idParam(req.params.id);
  const payslip = await getPayslipDetail(payrollId, facultyId);
  if (!payslip) throw notFound('Payslip');

  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.json(payslip);
  }
  res.render('faculty/payslip-detail', {
    title: `Payslip · ${payslip.period_text}`,
    nav: 'payroll',
    payslip,
  });
});
