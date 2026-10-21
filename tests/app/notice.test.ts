/**
 * T8-1 (Notices) page and permission tests: posting, audiences, reading and withdrawing.
 * Test notices have titles starting with "[test]" and are removed afterwards.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const ADMIN = process.env.ADMIN_PASSWORD ?? '';
const STUDENT = 'STU202600004';
const FACULTY = 'FAC-CSE-074';

const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAppEnv)('T8-1 notices (pages and permissions)', () => {
  const app = createApp!();
  const db = pool!;
  type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
  let admin: Agent;
  let student: Agent;
  let faculty: Agent;
  let studentDivision = '';          // division code of the demo student this term
  let taught: { id: number; code: string };
  let notTaught: { id: number; code: string };

  const cleanup = () => db.query(`DELETE FROM notice WHERE title LIKE '[test]%'`);
  const idFrom = (location: string | undefined) => Number(/\/notices\/(\d+)$/.exec(location ?? '')?.[1]);
  const reach = async (id: number) =>
    (await db.query<{ recipients: number; reads: number }>('SELECT recipients, reads FROM v_notice_reach WHERE notice_id = $1', [id])).rows[0]!;

  beforeAll(async () => {
    await cleanup();
    admin = (await signIn(app, 'admin', ADMIN)).agent;
    student = (await signIn(app, STUDENT.toLowerCase(), DEMO)).agent;
    faculty = (await signIn(app, FACULTY, DEMO)).agent;
    studentDivision = (await db.query<{ division_code: string }>(
      `SELECT d.division_code FROM student_section ss JOIN student s USING (student_id) JOIN division d USING (division_id)
       WHERE s.student_number = $1 AND ss.academic_session_id = current_session_id()`, [STUDENT])).rows[0]!.division_code;
    const divs = (await db.query<{ id: number; code: string; teaches: boolean }>(
      `SELECT d.division_id AS id, d.division_code AS code,
              EXISTS (SELECT 1 FROM teaching_assignment ta JOIN faculty f USING (faculty_id)
                      WHERE f.faculty_code = $1 AND ta.division_id = d.division_id) AS teaches
       FROM division d WHERE d.academic_session_id = current_session_id() ORDER BY d.division_id`, [FACULTY])).rows;
    taught = divs.find((d) => d.teaches)!;
    notTaught = divs.find((d) => !d.teaches)!;
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it('sends signed-out visitors to the login page', async () => {
    const res = await request(app).get('/student/notices');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  it('keeps students out of posting and the admin pages', async () => {
    expect([403, 404]).toContain((await student.get('/admin/notices')).status);
    expect((await student.get('/student/notices/new')).status).toBe(403);
    const res = await postForm(student, '/student/notices', '/student/notices',
      { title: '[test] student post', body: 'Students are not allowed to post.', category: 'General', division_ids: String(taught.id) });
    expect(res.status).toBe(403);
    expect((await db.query(`SELECT 1 FROM notice WHERE title = '[test] student post'`)).rows).toHaveLength(0);
  });

  it('admin posts to one division; exactly its students receive it', async () => {
    const res = await postForm(admin, '/admin/notices/new', '/admin/notices', {
      title: '[test] Division notice', body: 'Only one division should receive this notice.', category: 'Academic',
      audience: 'division', division_codes: studentDivision.toLowerCase(),
    });
    const id = idFrom(res.headers.location);
    expect(id).toBeGreaterThan(0);
    const members = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM student_section ss JOIN division d USING (division_id) JOIN app_user u USING (student_id)
       WHERE d.division_code = $1 AND ss.academic_session_id = current_session_id() AND u.is_active`, [studentDivision]);
    expect((await reach(id)).recipients).toBe(members.rows[0]!.n);

    // the student sees it on the board and the dashboard; faculty do not
    expect((await student.get('/student/notices')).text).toContain('[test] Division notice');
    expect((await student.get('/student')).text).toContain('[test] Division notice');
    expect((await faculty.get('/faculty/notices')).text).not.toContain('[test] Division notice');
    expect((await faculty.get(`/faculty/notices/${id}`)).status).toBe(404);

    // opening it marks it read
    const detail = await student.get(`/student/notices/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('Only one division should receive this notice.');
    expect((await reach(id)).reads).toBe(1);
  });

  it('rejects unknown division codes and missing fields', async () => {
    const res = await postForm(admin, '/admin/notices/new', '/admin/notices', {
      title: '[test] Bad division', body: 'This division code does not exist.', category: 'General',
      audience: 'division', division_codes: 'XYZ-Y9-Q',
    });
    expect(res.headers.location).toBe('/admin/notices/new');
    const short = await postForm(admin, '/admin/notices/new', '/admin/notices', { title: '[t]', body: 'short', category: 'General', audience: 'everyone' });
    expect(short.headers.location).toBe('/admin/notices/new');
    expect((await db.query(`SELECT 1 FROM notice WHERE title LIKE '[test] Bad%' OR title = '[t]'`)).rows).toHaveLength(0);
  });

  it('mark all read clears the unread count', async () => {
    await postForm(admin, '/admin/notices/new', '/admin/notices', {
      title: '[test] Everyone notice', body: 'A notice for the whole college.', category: 'Event', audience: 'everyone', is_important: 'on',
    });
    expect((await student.get('/student/notices')).text).toContain('Mark all read');
    await postForm(student, '/student/notices', '/student/notices/read-all', {});
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM v_user_notices v JOIN app_user u USING (user_id) WHERE u.login_id = $1 AND NOT v.is_read`, [STUDENT]);
    expect(rows[0]!.n).toBe(0);
  });

  it('faculty post only to divisions they teach, and can withdraw their own notice', async () => {
    const form = await faculty.get('/faculty/notices/new');
    expect(form.text).toContain(taught.code);
    expect(form.text).not.toContain(`value="${notTaught.id}"`);

    // a tampered form naming another division is refused by the database
    const bad = await postForm(faculty, '/faculty/notices/new', '/faculty/notices', {
      title: '[test] Not my division', body: 'I do not teach this division.', category: 'Academic', division_ids: String(notTaught.id),
    });
    expect(bad.headers.location).toBe('/faculty/notices/new');
    expect((await db.query(`SELECT 1 FROM notice WHERE title = '[test] Not my division'`)).rows).toHaveLength(0);

    const ok = await postForm(faculty, '/faculty/notices/new', '/faculty/notices', {
      title: '[test] Lab moved', body: 'Thursday lab is in A-204 from this week.', category: 'Academic', division_ids: String(taught.id),
    });
    const id = idFrom(ok.headers.location);
    expect(id).toBeGreaterThan(0);
    expect((await faculty.get('/faculty/notices')).text).toContain('[test] Lab moved');

    await postForm(faculty, `/faculty/notices/${id}`, `/faculty/notices/${id}/withdraw`, {});
    const { rows } = await db.query('SELECT withdrawn_at FROM notice WHERE notice_id = $1', [id]);
    expect(rows[0].withdrawn_at).not.toBeNull();
    // withdrawing someone else's notice is not possible
    const other = await db.query<{ notice_id: number }>(`SELECT notice_id FROM notice WHERE title = '[test] Everyone notice'`);
    const res = await postForm(faculty, '/faculty/notices', `/faculty/notices/${other.rows[0]!.notice_id}/withdraw`, {});
    expect(res.status).toBe(404);
  });

  it('admin can withdraw; the notice leaves every board', async () => {
    const { rows } = await db.query<{ notice_id: number }>(`SELECT notice_id FROM notice WHERE title = '[test] Everyone notice'`);
    const id = rows[0]!.notice_id;
    await postForm(admin, `/admin/notices/${id}`, `/admin/notices/${id}/withdraw`, {});
    expect((await student.get('/student/notices')).text).not.toContain('[test] Everyone notice');
    expect((await student.get(`/student/notices/${id}`)).status).toBe(404);
    expect((await admin.get(`/admin/notices/${id}`)).text).toContain('Withdrawn');
    const log = await db.query(`SELECT action FROM audit_log WHERE entity = 'notice' AND entity_id = $1 ORDER BY audit_id`, [String(id)]);
    expect(log.rows.map((r) => r.action)).toEqual(['NOTICE_POST', 'NOTICE_WITHDRAW']);
  });
});
