/** Admin: students, faculty and their login accounts. */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { hashPassword } from '../../auth/password.js';
import { query, queryOne, transaction } from '../../db.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/http-error.js';
import { pageInfo, parsePage, withQuery } from '../../lib/pagination.js';
import { flash } from '../../middleware/auth.js';
import { getFacultyClasses, getFacultyProfile } from '../../queries/faculty-queries.js';
import { getStudentCourses, getStudentProfile } from '../../queries/shared-queries.js';
import { handleForm, idParam, nullIfEmpty } from './helpers.js';

export const peopleRouter = Router();

const DEPT_IDS = ['AIDS', 'CIVIL', 'CSE', 'EE', 'ENTC', 'IT', 'MECH'];

interface AccountRow {
  user_id: number; login_id: string; is_active: boolean; must_change_password: boolean; failed_logins: number;
  locked_until: Date | null; last_login_at: Date | null; password_changed_at: Date | null;
}
const accountFor = (column: 'student_id' | 'faculty_id', id: number): Promise<AccountRow | undefined> =>
  queryOne<AccountRow>(`SELECT user_id, login_id, is_active, must_change_password, failed_logins, locked_until,
                               last_login_at, password_changed_at FROM app_user WHERE ${column} = $1`, [id]);

// ---------------------------------------------------------------- students
peopleRouter.get('/students', async (req, res) => {
  const filters = {
    q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '',
    dept: DEPT_IDS.includes(String(req.query.dept)) ? String(req.query.dept) : '',
    year: ['1', '2', '3', '4'].includes(String(req.query.year)) ? String(req.query.year) : '',
    status: ['Active', 'Graduated', 'Inactive'].includes(String(req.query.status)) ? String(req.query.status) : '',
  };
  const page = parsePage(req.query.page);
  const from = `FROM student s JOIN program p USING (program_id)
    LEFT JOIN student_section ss ON ss.student_id = s.student_id AND ss.academic_session_id = current_session_id()
    LEFT JOIN division d ON d.division_id = ss.division_id
    WHERE ($1::text = '' OR s.student_number ILIKE $1::text || '%' OR s.admission_number ILIKE $1::text || '%' OR s.email ILIKE $1::text || '%'
           OR (s.first_name || ' ' || s.last_name) ILIKE '%' || $1::text || '%')
      AND ($2::text = '' OR p.dept_id = $2::text) AND ($3::text = '' OR d.year_of_study::text = $3::text) AND ($4::text = '' OR s.status::text = $4::text)`;
  const params = [filters.q, filters.dept, filters.year, filters.status];
  const [rows, count] = await Promise.all([
    query(`SELECT s.student_id, s.student_number, s.first_name || ' ' || s.last_name AS name, s.status, s.admission_type,
                  p.dept_id, d.division_code, d.year_of_study, ss.roll_no
           ${from} ORDER BY s.student_number LIMIT $5 OFFSET $6`, [...params, page.limit, page.offset]),
    queryOne<{ n: number }>(`SELECT count(*) AS n ${from}`, params),
  ]);
  res.render('admin/students', {
    title: 'Students', nav: 'students', rows, filters, depts: DEPT_IDS,
    pager: pageInfo(page, count?.n ?? 0), qs: (o: Record<string, unknown>) => withQuery(filters, o),
  });
});

peopleRouter.get('/students/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const [profile, courses, account] = await Promise.all([getStudentProfile(id), getStudentCourses(id), accountFor('student_id', id)]);
  if (!profile) throw notFound('Student');
  res.render('admin/student-detail', {
    title: `${profile.first_name} ${profile.last_name}`, nav: 'students', profile, courses, account,
    editing: req.query.edit === '1',
  });
});

const studentSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(50),
  middle_name: z.string().trim().max(50),
  last_name: z.string().trim().min(1, 'Last name is required').max(50),
  date_of_birth: z.iso.date('Enter a valid date of birth'),
  gender: z.enum(['Male', 'Female', 'Other']),
  blood_group: z.union([z.literal(''), z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])]),
  category: z.enum(['General', 'OBC', 'SC', 'ST', 'EWS']),
  status: z.enum(['Active', 'Graduated', 'Inactive']),
  email: z.email('Enter a valid college e-mail').max(120),
  personal_email: z.union([z.literal(''), z.email('Enter a valid personal e-mail').max(120)]),
  mobile_number: z.string().regex(/^[6-9]\d{9}$/, 'Mobile must be a 10-digit Indian number'),
  alternate_mobile: z.union([z.literal(''), z.string().regex(/^[6-9]\d{9}$/, 'Alternate mobile must be a 10-digit Indian number')]),
  address: z.string().trim().max(200),
  district_name: z.string().trim().max(60),
  pincode: z.union([z.literal(''), z.string().regex(/^[1-9]\d{5}$/, 'PIN code must be 6 digits')]),
});

peopleRouter.post('/students/:id', (req, res) => handleForm(req, res, studentSchema, `/admin/students/${req.params.id}?edit=1`, async (v) => {
  const id = idParam(req.params.id);
  await transaction(async (db) => {
    const before = await queryOne('SELECT * FROM student WHERE student_id = $1', [id], db);
    if (!before) throw notFound('Student');
    await db.query(`UPDATE student SET first_name = $2, middle_name = $3, last_name = $4, date_of_birth = $5, gender = $6,
                      blood_group = $7, category = $8, status = $9, email = $10, personal_email = $11, mobile_number = $12,
                      alternate_mobile = $13, address = $14, district_name = $15, pincode = $16
                    WHERE student_id = $1`,
      [id, v.first_name, nullIfEmpty(v.middle_name), v.last_name, v.date_of_birth, v.gender, nullIfEmpty(v.blood_group),
        v.category, v.status, v.email, nullIfEmpty(v.personal_email), v.mobile_number, nullIfEmpty(v.alternate_mobile),
        nullIfEmpty(v.address), nullIfEmpty(v.district_name), nullIfEmpty(v.pincode)]);
    await audit(req, { action: 'STUDENT_UPDATE', entity: 'student', entityId: id, details: { before, after: v } }, db);
  });
  return { message: 'Student record updated.', redirect: `/admin/students/${id}` };
}));

// ---------------------------------------------------------------- faculty
peopleRouter.get('/faculty', async (req, res) => {
  const filters = {
    q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '',
    dept: DEPT_IDS.includes(String(req.query.dept)) ? String(req.query.dept) : '',
  };
  const page = parsePage(req.query.page);
  const where = `($1::text = '' OR f.faculty_code ILIKE '%' || $1::text || '%' OR (f.first_name || ' ' || f.last_name) ILIKE '%' || $1::text || '%')
                 AND ($2::text = '' OR f.dept_id = $2::text)`;
  const [rows, count] = await Promise.all([
    query(`SELECT f.faculty_id, f.faculty_code, f.first_name || ' ' || f.last_name AS name, f.designation, f.dept_id, f.status,
                  d.hod_faculty_id = f.faculty_id AS is_hod,
                  (SELECT coalesce(sum(te.periods), 0) FROM timetable_entry te
                    WHERE te.faculty_id = f.faculty_id AND te.academic_session_id = current_session_id())::int AS weekly_hours
           FROM faculty f JOIN department d USING (dept_id) WHERE ${where}
           ORDER BY f.faculty_code LIMIT $3 OFFSET $4`, [filters.q, filters.dept, page.limit, page.offset]),
    queryOne<{ n: number }>(`SELECT count(*) AS n FROM faculty f WHERE ${where}`, [filters.q, filters.dept]),
  ]);
  res.render('admin/faculty', {
    title: 'Faculty', nav: 'faculty', rows, filters, depts: DEPT_IDS,
    pager: pageInfo(page, count?.n ?? 0), qs: (o: Record<string, unknown>) => withQuery(filters, o),
  });
});

peopleRouter.get('/faculty/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const [profile, classes, account] = await Promise.all([getFacultyProfile(id), getFacultyClasses(id), accountFor('faculty_id', id)]);
  if (!profile) throw notFound('Faculty member');
  res.render('admin/faculty-detail', {
    title: `${profile.first_name} ${profile.last_name}`, nav: 'faculty', profile, classes, account, editing: req.query.edit === '1',
  });
});

const facultySchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(50),
  last_name: z.string().trim().min(1, 'Last name is required').max(50),
  designation: z.enum(['Professor', 'Associate Professor', 'Assistant Professor']),
  qualification: z.string().trim().min(1).max(20),
  email: z.email('Enter a valid e-mail').max(120),
  mobile_number: z.string().regex(/^[6-9]\d{9}$/, 'Mobile must be a 10-digit Indian number'),
  status: z.enum(['Active', 'Inactive']),
});

peopleRouter.post('/faculty/:id', (req, res) => handleForm(req, res, facultySchema, `/admin/faculty/${req.params.id}?edit=1`, async (v) => {
  const id = idParam(req.params.id);
  await transaction(async (db) => {
    const before = await queryOne('SELECT * FROM faculty WHERE faculty_id = $1', [id], db);
    if (!before) throw notFound('Faculty member');
    await db.query(`UPDATE faculty SET first_name = $2, last_name = $3, designation = $4, qualification = $5, email = $6,
                      mobile_number = $7, status = $8 WHERE faculty_id = $1`,
      [id, v.first_name, v.last_name, v.designation, v.qualification, v.email, v.mobile_number, v.status]);
    await audit(req, { action: 'FACULTY_UPDATE', entity: 'faculty', entityId: id, details: { before, after: v } }, db);
  });
  return { message: 'Faculty record updated.', redirect: `/admin/faculty/${id}` };
}));

// ---------------------------------------------------------------- accounts
async function accountOwnerPath(userId: number): Promise<string> {
  const u = await queryOne<{ student_id: number | null; faculty_id: number | null }>(
    'SELECT student_id, faculty_id FROM app_user WHERE user_id = $1', [userId]);
  if (!u) throw notFound('Account');
  return u.student_id ? `/admin/students/${u.student_id}` : u.faculty_id ? `/admin/faculty/${u.faculty_id}` : '/admin';
}

/** Issue a one-time temporary password (shown once to the admin, must be changed at next login). */
peopleRouter.post('/users/:id/reset-password', async (req, res) => {
  const userId = idParam(req.params.id);
  const back = await accountOwnerPath(userId);
  if (userId === req.user!.userId) {
    flash(req, 'error', 'Use “Change password” to change your own password.');
    res.redirect(back);
    return;
  }
  const temporary = `${randomBytes(6).toString('base64url')}${Math.floor(10 + Math.random() * 90)}`;
  await transaction(async (db) => {
    await db.query(`UPDATE app_user SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL
                    WHERE user_id = $1`, [userId, await hashPassword(temporary)]);
    await db.query(`DELETE FROM user_session WHERE (sess -> 'userId')::text = $1`, [String(userId)]);   // sign out everywhere
    await audit(req, { action: 'PASSWORD_RESET', entity: 'app_user', entityId: userId }, db);
  });
  flash(req, 'info', `Temporary password: ${temporary} — share it with the user; they must change it when they sign in.`);
  res.redirect(back);
});

peopleRouter.post('/users/:id/unlock', async (req, res) => {
  const userId = idParam(req.params.id);
  await transaction(async (db) => {
    await db.query('UPDATE app_user SET failed_logins = 0, locked_until = NULL WHERE user_id = $1', [userId]);
    await audit(req, { action: 'ACCOUNT_UNLOCK', entity: 'app_user', entityId: userId }, db);
  });
  flash(req, 'success', 'Account unlocked.');
  res.redirect(await accountOwnerPath(userId));
});

peopleRouter.post('/users/:id/toggle-active', async (req, res) => {
  const userId = idParam(req.params.id);
  const back = await accountOwnerPath(userId);
  if (userId === req.user!.userId) {
    flash(req, 'error', 'You cannot disable your own account.');
    res.redirect(back);
    return;
  }
  const row = await transaction(async (db) => {
    const r = await queryOne<{ is_active: boolean }>(
      'UPDATE app_user SET is_active = NOT is_active WHERE user_id = $1 RETURNING is_active', [userId], db);
    await audit(req, { action: r?.is_active ? 'ACCOUNT_ENABLE' : 'ACCOUNT_DISABLE', entity: 'app_user', entityId: userId }, db);
    return r;
  });
  flash(req, 'success', row?.is_active ? 'Account enabled.' : 'Account disabled; the user can no longer sign in.');
  res.redirect(back);
});
