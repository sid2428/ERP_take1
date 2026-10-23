import { getFacultySyllabusPct, getRecentSessions, getSyllabusSummary, getUnitProgress } from '../queries/syllabus-queries.js';
import { Router } from 'express';
import { isoWeekday, termProgress, todayIso } from '../lib/format.js';
import { forbidden, notFound } from '../lib/http-error.js';
import { getAssignment, getFacultyClasses, getFacultyProfile, getRoster, teachesStudent } from '../queries/faculty-queries.js';
import { getFacultyTimetable, getStudentCourses, getStudentProfile, nextClassDay } from '../queries/shared-queries.js';
import { grievanceRouter } from './grievance-routes.js';
import { noticeRouter } from './notice-routes.js';
import { noticeSummary } from '../queries/notice-queries.js';
import { facultyAttendanceRouter } from './faculty-attendance-routes.js';
import { facultyExaminationRouter } from './faculty-examination-routes.js';

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
  const [profile, classes, timetable, notices] = await Promise.all([
    getFacultyProfile(facultyId), getFacultyClasses(facultyId), getFacultyTimetable(facultyId),
    noticeSummary(req.user!.userId, 4, res.locals.notificationUnreadCount),
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
