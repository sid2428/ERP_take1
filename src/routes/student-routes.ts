import { Router } from 'express';
import { z } from 'zod';
import { friendlyDbError, query, queryOne } from '../db.js';
import { audit } from '../lib/audit.js';
import { isoWeekday, termProgress, todayIso } from '../lib/format.js';
import { notFound } from '../lib/http-error.js';
import { flash } from '../middleware/auth.js';
import { getCurriculum, getStudentCourses, getStudentProfile, getStudentTimetable, nextClassDay } from '../queries/shared-queries.js';

export const studentRouter = Router();

studentRouter.get('/', async (req, res) => {
  const studentId = req.user!.studentId!;
  const [profile, courses, timetable, overall] = await Promise.all([
    getStudentProfile(studentId),
    getStudentCourses(studentId),
    getStudentTimetable(studentId),
    queryOne<{ total_sessions: number; attended: number; overall_pct: number | null }>(
      `SELECT total_sessions, attended, overall_pct FROM v_student_attendance_overall
        WHERE student_id = $1 AND academic_session_id = current_session_id()`, [studentId]),
  ]);
  if (!profile) throw notFound('Student record');

  const session = res.locals.currentSession as { start_date: string; end_date: string } | undefined;
  const today = todayIso();
  const credits = courses.reduce((acc, c) => {
    acc.total += c.credits;
    acc[c.course_type === 'LAB' ? 'lab' : 'theory'] += c.credits;
    return acc;
  }, { total: 0, theory: 0, lab: 0 });

  res.render('student/dashboard', {
    title: 'Dashboard', nav: 'dashboard', profile, courses, overall, credits,
    progress: session ? termProgress(session.start_date, session.end_date, today) : null,
    shortage: courses.filter((c) => c.eligibility === 'Shortage'),
    classDay: nextClassDay(timetable, isoWeekday(today)),
  });
});

studentRouter.get('/curriculum', async (req, res) => {
  const profile = await getStudentProfile(req.user!.studentId!);
  if (!profile) throw notFound('Student record');
  const rows = await getCurriculum(profile.program_id);
  const semesters = Array.from({ length: profile.total_semesters }, (_, i) => ({
    no: i + 1, courses: rows.filter((r) => r.semester_no === i + 1),
  }));
  res.render('student/curriculum', { title: 'Curriculum', nav: 'curriculum', profile, semesters });
});

studentRouter.get('/offerings', async (req, res) => {
  const profile = await getStudentProfile(req.user!.studentId!);
  if (!profile) throw notFound('Student record');
  const courses = await getStudentCourses(req.user!.studentId!);
  const totalCredits = courses.reduce((sum, c) => sum + c.credits, 0);
  res.render('student/offerings', { title: 'Course offerings', nav: 'offerings', profile, courses, totalCredits });
});

studentRouter.get('/profile', async (req, res) => {
  const profile = await getStudentProfile(req.user!.studentId!);
  if (!profile) throw notFound('Student record');
  res.render('student/profile', { title: 'Profile', nav: 'profile', profile, errors: null });
});

// Students may update their own contact details; everything else is maintained by the Admin.
const contactSchema = z.object({
  personal_email: z.union([z.literal(''), z.email('Enter a valid personal e-mail address').max(120)]),
  alternate_mobile: z.union([z.literal(''), z.string().regex(/^[6-9]\d{9}$/, 'Alternate mobile must be a 10-digit Indian number')]),
  address: z.string().trim().max(200),
  district_name: z.string().trim().max(60),
  pincode: z.union([z.literal(''), z.string().regex(/^[1-9]\d{5}$/, 'PIN code must be 6 digits')]),
});

studentRouter.post('/profile', async (req, res) => {
  const studentId = req.user!.studentId!;
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    const profile = await getStudentProfile(studentId);
    res.status(400).render('student/profile', {
      title: 'Profile', nav: 'profile', profile: { ...profile, ...req.body },
      errors: parsed.error.issues.map((i) => i.message),
    });
    return;
  }
  const v = parsed.data;
  const empty = (s: string): string | null => (s === '' ? null : s);
  try {
    const [before] = await query<Record<string, unknown>>(
      'SELECT personal_email, alternate_mobile, address, district_name, pincode FROM student WHERE student_id = $1', [studentId]);
    await query(`UPDATE student SET personal_email = $2, alternate_mobile = $3, address = $4, district_name = $5, pincode = $6
                 WHERE student_id = $1`,
      [studentId, empty(v.personal_email), empty(v.alternate_mobile), empty(v.address), empty(v.district_name), empty(v.pincode)]);
    await audit(req, { action: 'PROFILE_UPDATE', entity: 'student', entityId: studentId, details: { before, after: v } });
    flash(req, 'success', 'Your contact details were updated.');
  } catch (err) {
    flash(req, 'error', friendlyDbError(err) ?? 'Could not save your changes.');
  }
  res.redirect('/student/profile');
});
