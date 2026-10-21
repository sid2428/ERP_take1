import { Router } from 'express';
import { z } from 'zod';
import { friendlyDbError, query, queryOne, pool } from '../db.js';
import { audit } from '../lib/audit.js';
import { isoWeekday, termProgress, todayIso } from '../lib/format.js';
import { notFound } from '../lib/http-error.js';
import { flash } from '../middleware/auth.js';
import { getCurriculum, getStudentCourses, getStudentProfile, getStudentTimetable, nextClassDay } from '../queries/shared-queries.js';
import { getStudentElectiveOfferings, getStudentElectiveResult, getStudentElectiveWindows } from '../queries/academic-queries.js';
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

studentRouter.get('/fee', (_req, res) => {
  res.render('student/fee', { title: 'Fee & D-Wallet', nav: 'fee' });
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





// ---- T3-2: elective selection (student side). APPEND to src/routes/student-routes.ts ----
//
// Also change two imports at the top of that file:
//   import { friendlyDbError, pool, query, queryOne } from '../db.js';          // add `pool`
//   import { getStudentElectiveOfferings, getStudentElectiveResult, getStudentElectiveWindows }
//     from '../queries/academic-queries.js';                                      // new line

studentRouter.get('/electives', async (req, res) => {
  const studentId = req.user!.studentId!;
  const windows = await getStudentElectiveWindows(studentId);
  const items = await Promise.all(windows.map(async (w) => ({
    ...w,
    offerings: await getStudentElectiveOfferings(w.window_id, studentId),
    result: await getStudentElectiveResult(w.window_id, studentId),
  })));
  res.render('student/electives', { title: 'Electives', nav: 'electives', windows: items });
});

const pick = z.string().regex(/^\d*$/).optional();
const electiveForm = z.object({ choice1: pick, choice2: pick, choice3: pick, choice4: pick, choice5: pick });

studentRouter.post('/electives/:windowId', async (req, res) => {
  const studentId = req.user!.studentId!;
  const windowId = Number(req.params.windowId);
  if (!Number.isInteger(windowId) || windowId <= 0) throw notFound('Elective window');

  const window = (await getStudentElectiveWindows(studentId)).find((w) => w.window_id === windowId);
  if (!window) throw notFound('Elective window');

  const parsed = electiveForm.safeParse(req.body);
  if (!parsed.success) {
    flash(req, 'error', 'Your choices could not be read. Please try again.');
    res.redirect('/student/electives');
    return;
  }
  const d = parsed.data;
  // keep the order the student chose, close any gaps, and drop empty slots
  const offeringIds = [d.choice1, d.choice2, d.choice3, d.choice4, d.choice5]
    .filter((v): v is string => v !== undefined && v !== '')
    .map(Number);
  if (offeringIds.length === 0) {
    flash(req, 'error', 'Pick at least one elective.');
    res.redirect('/student/electives');
    return;
  }
  if (offeringIds.length > window.max_choices) {
    flash(req, 'error', `You can rank at most ${window.max_choices} electives.`);
    res.redirect('/student/electives');
    return;
  }
  if (new Set(offeringIds).size !== offeringIds.length) {
    flash(req, 'error', 'Each choice must be a different course.');
    res.redirect('/student/electives');
    return;
  }
  const allowed = new Set((await getStudentElectiveOfferings(windowId, studentId)).map((o) => o.offering_id));
  if (!offeringIds.every((id) => allowed.has(id))) {
    flash(req, 'error', 'One of the selected courses is not available to you.');
    res.redirect('/student/electives');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // the database trigger rejects both statements unless the window is open
    await client.query('DELETE FROM elective_preference WHERE window_id = $1 AND student_id = $2', [windowId, studentId]);
    for (const [i, offeringId] of offeringIds.entries()) {
      await client.query(
        `INSERT INTO elective_preference (window_id, student_id, offering_id, preference_rank) VALUES ($1, $2, $3, $4)`,
        [windowId, studentId, offeringId, i + 1]);
    }
    await audit(req, { action: 'ELECTIVE_CHOICES', entity: 'elective_window', entityId: windowId,
      details: { offeringIds } }, client);
    await client.query('COMMIT');
    flash(req, 'success', 'Your elective choices were saved.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    flash(req, 'error', friendlyDbError(err) ?? 'Could not save your choices.');
  } finally {
    client.release();
  }
  res.redirect('/student/electives');
});