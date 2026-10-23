/**
 * End-to-end HTTP tests against the real app and the loaded local database.
 * Temporary accounts are created with login ids starting TEST- and removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const ADMIN = process.env.ADMIN_PASSWORD ?? '';
const TEMP_PASSWORD = 'Temp-pass-2026';

// the app reads its configuration on import, so only load it when the environment is set up
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAppEnv)('PICT ERP portal', () => {
  const app = hasAppEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);
  const db = pool!;

  beforeAll(async () => {
    const hash = await hashPassword(TEMP_PASSWORD);
    await db.query(`DELETE FROM app_user WHERE login_id LIKE 'TEST-%'`);
    await db.query(`INSERT INTO app_user (login_id, role, password_hash, must_change_password)
                      VALUES ('TEST-LOCK', 'admin', $1, false), ('TEST-NEW', 'admin', $1, true)`, [hash]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM app_user WHERE login_id LIKE 'TEST-%'`);
    await db.end();
  });

  describe('sign-in', () => {
    it('serves the login page with a CSRF token and security headers', async () => {
      const { agent } = await signIn(app, 'nobody', 'x');
      const res = await agent.get('/login');
      expect(res.status).toBe(200);
      expect(res.text).toContain('name="_csrf"');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('rejects a form posted without the CSRF token', async () => {
      const { default: request } = await import('supertest');
      const res = await request(app).post('/login').type('form').send({ login_id: 'admin', password: ADMIN });
      expect(res.status).toBe(403);
    });

    it('gives the same message for an unknown user and a wrong password', async () => {
      const unknown = await signIn(app, 'NOSUCHUSER', 'whatever1');
      const wrong = await signIn(app, 'STU202600004', 'wrong-password-1');
      expect(unknown.res.status).toBe(401);
      expect(wrong.res.status).toBe(401);
      expect(unknown.res.text).toContain('Incorrect login ID or password.');
      expect(wrong.res.text).toContain('Incorrect login ID or password.');
    });

    it('locks an account after five failed attempts', async () => {
      for (let i = 0; i < 5; i++) await signIn(app, 'TEST-LOCK', 'bad-password-1');
      const { res } = await signIn(app, 'TEST-LOCK', TEMP_PASSWORD);   // even the right password is refused now
      expect(res.status).toBe(401);
      expect(res.text).toMatch(/Too many failed attempts/);
    });

    it('signs in, accepts lower-case login ids, and ignores off-site "next" targets', async () => {
      const { res } = await signIn(app, 'stu202600004', DEMO, '//evil.example.com');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/student');
    });

    it('forces a password change on first sign-in, then lets the user in', async () => {
      const { agent } = await signIn(app, 'TEST-NEW', TEMP_PASSWORD);
      const blocked = await agent.get('/admin');
      expect(blocked.headers.location).toBe('/account/password');

      const weak = await postForm(agent, '/account/password', '/account/password',
        { current_password: TEMP_PASSWORD, new_password: 'abcdefgh', confirm_password: 'abcdefgh' });
      expect(weak.status).toBe(400);

      const ok = await postForm(agent, '/account/password', '/account/password',
        { current_password: TEMP_PASSWORD, new_password: 'Fresh-start-77', confirm_password: 'Fresh-start-77' });
      expect(ok.status).toBe(302);
      expect((await agent.get('/admin')).status).toBe(200);
    });

    it('signs out and protects pages again', async () => {
      const { agent } = await signIn(app, 'admin', ADMIN);
      await postForm(agent, '/admin', '/logout', {});
      const after = await agent.get('/admin');
      expect(after.status).toBe(302);
      expect(after.headers.location).toMatch(/^\/login/);
    });
  });

  describe('role boundaries', () => {
    it('sends anonymous visitors to the login page', async () => {
      const { default: request } = await import('supertest');
      const res = await request(app).get('/student/profile');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/login?next=%2Fstudent%2Fprofile');
    });

    it('shows a student their own dashboard and nothing else', async () => {
      const { agent } = await signIn(app, 'STU202600004', DEMO);
      const dash = await agent.get('/student');
      expect(dash.status).toBe(200);
      expect(dash.text).toContain('STU202600004');
      expect(dash.text).toContain('Semester V of 8');
      expect((await agent.get('/admin')).status).toBe(403);
      expect((await agent.get('/faculty')).status).toBe(403);
    });

    it('lets faculty open only their own classes and students', async () => {
      const { rows } = await db.query<{ own: number; other: number; outsider: number; insider: number }>(`
        WITH me AS (SELECT faculty_id FROM faculty WHERE faculty_code = 'FAC-CSE-074')
        SELECT (SELECT min(assignment_id) FROM teaching_assignment WHERE faculty_id = (SELECT faculty_id FROM me)) AS own,
               (SELECT min(assignment_id) FROM teaching_assignment WHERE faculty_id <> (SELECT faculty_id FROM me)) AS other,
               (SELECT min(r.student_id) FROM v_assignment_roster r JOIN teaching_assignment t USING (assignment_id)
                 WHERE t.faculty_id = (SELECT faculty_id FROM me)) AS insider,
               (SELECT min(student_id) FROM student WHERE status = 'Graduated') AS outsider`);
      const ids = rows[0]!;
      const { agent } = await signIn(app, 'FAC-CSE-074', DEMO);
      expect((await agent.get(`/faculty/classes/${ids.own}`)).status).toBe(200);
      expect((await agent.get(`/faculty/classes/${ids.other}`)).status).toBe(404);
      expect((await agent.get(`/faculty/students/${ids.insider}`)).status).toBe(200);
      expect((await agent.get(`/faculty/students/${ids.outsider}`)).status).toBe(403);
    });
  });

  describe('admin console', () => {
    it('renders every admin page', async () => {
      const { agent } = await signIn(app, 'admin', ADMIN);
      for (const path of ['/admin', '/admin/departments', '/admin/departments/CSE', '/admin/programs', '/admin/programs/BTECH-IT',
        '/admin/courses', '/admin/courses?dept=IT&type=LAB', '/admin/courses/new', '/admin/courses/4', '/admin/sessions',
        '/admin/sections', '/admin/sections/divisions/1', '/admin/students?q=STU2026000', '/admin/students/4',
        '/admin/faculty', '/admin/faculty/1', '/admin/audit', '/admin/attendance-unlocks']) {
        const res = await agent.get(path);
        expect(res.status, path).toBe(200);
      }
    });

    it('finds a student by number', async () => {
      const { agent } = await signIn(app, 'admin', ADMIN);
      const res = await agent.get('/admin/students?q=STU202600004');
      expect(res.text).toContain('Aishani Sharaf');
      expect(res.text).toContain('Showing 1–1 of 1');
    });

    it('updates a course, records it in the audit log, and validates input', async () => {
      const before = (await db.query('SELECT * FROM course WHERE course_id = 4')).rows[0];
      const { agent } = await signIn(app, 'admin', ADMIN);
      const fields = {
        course_code: before.course_code, course_name: before.course_name, dept_id: before.dept_id, credits: String(before.credits),
        course_type: before.course_type, lecture_hrs: String(before.lecture_hrs), tutorial_hrs: String(before.tutorial_hrs),
        practical_hrs: String(before.practical_hrs), syllabus_version: before.syllabus_version, is_active: 'on',
      };
      try {
        const bad = await postForm(agent, '/admin/courses/4', '/admin/courses/4', { ...fields, min_attendance_pct: '150' });
        expect(bad.status).toBe(302);
        expect((await db.query('SELECT min_attendance_pct FROM course WHERE course_id = 4')).rows[0].min_attendance_pct).toBe(before.min_attendance_pct);

        await postForm(agent, '/admin/courses/4', '/admin/courses/4', { ...fields, min_attendance_pct: '80' });
        expect((await db.query('SELECT min_attendance_pct FROM course WHERE course_id = 4')).rows[0].min_attendance_pct).toBe(80);
        const log = await db.query(`SELECT 1 FROM audit_log WHERE action = 'COURSE_UPDATE' AND entity_id = '4' AND occurred_at > now() - interval '1 minute'`);
        expect(log.rowCount).toBeGreaterThan(0);
      } finally {
        await db.query('UPDATE course SET min_attendance_pct = $1 WHERE course_id = 4', [before.min_attendance_pct]);
      }
    });

    it('shows the database rule when a prerequisite would create a cycle', async () => {
      const { agent } = await signIn(app, 'admin', ADMIN);
      // CSE211 (4) requires CSE111 (1); making CSE111 require CSE211 closes a loop
      const res = await postForm(agent, '/admin/courses/1', '/admin/courses/1/prerequisites', { prereq_course_id: '4', min_grade: 'P' });
      expect(res.status).toBe(302);
      const page = await agent.get('/admin/courses/1');
      expect(page.text).toMatch(/prerequisite cycle detected/);
    });

    it('requires typing the session id before switching the current session', async () => {
      const { agent } = await signIn(app, 'admin', ADMIN);
      await postForm(agent, '/admin/sessions', '/admin/sessions/2026-EVEN/current', { confirm: 'wrong' });
      const page = await agent.get('/admin/sessions');
      expect(page.text).toContain('Type the session id to confirm');
      expect((await db.query('SELECT current_session_id() AS id')).rows[0].id).toBe('2026-ODD');
    });
  });
});
