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
  const app = hasAppEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);
  const db = pool!;
  type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
  let admin: Agent;
  let student: Agent;
  let faculty: Agent;
  let studentDivision = '';          // division code of the demo student this term
  let taught: { id: number; code: string };
  let notTaught: { id: number; code: string };

  const cleanup = async () => {
    await db.query(`DELETE FROM notification WHERE title LIKE '[test]%' OR link IN
      (SELECT '/admin/grievances/' || grievance_id FROM grievance WHERE subject LIKE '[test]%')`);
    await db.query(`DELETE FROM notice WHERE title LIKE '[test]%' OR (source = 'grievance' AND substring(link FROM '/grievances/([0-9]+)$')::int IN
                      (SELECT grievance_id FROM grievance WHERE subject LIKE '[test]%'))`);
    await db.query(`DELETE FROM grievance WHERE subject LIKE '[test]%'`);
  };
  const idFrom = (location: string | undefined) => Number(/\/notices\/(\d+)$/.exec(location ?? '')?.[1]);
  const reach = async (id: number) =>
    (await db.query<{ recipients: number; reads: number }>('SELECT recipients, reads FROM v_notice_reach WHERE notice_id = $1', [id])).rows[0]!;
  const userIdFor = async (loginId: string) =>
    (await db.query<{ user_id: number }>('SELECT user_id FROM app_user WHERE login_id = $1', [loginId])).rows[0]!.user_id;
  const unreadFor = async (userId: number) =>
    (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM v_user_notices WHERE user_id = $1 AND NOT is_read', [userId])).rows[0]!.n;
  const bellLabel = (html: string) => html.match(/class="notification-link"[^>]*aria-label="([^"]+)"/)?.[1];

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
    const state = await request(app).get('/api/notifications/state');
    expect(state.status).toBe(401);
  });

  it('keeps students out of posting and the admin pages', async () => {
    expect([403, 404]).toContain((await student.get('/admin/notices')).status);
    expect((await student.get('/student/notices/new')).status).toBe(403);
    const res = await postForm(student, '/student/notices', '/student/notices',
      { title: '[test] student post', body: 'Students are not allowed to post.', category: 'General', division_ids: String(taught.id) });
    expect(res.status).toBe(403);
    expect((await db.query(`SELECT 1 FROM notice WHERE title = '[test] student post'`)).rows).toHaveLength(0);
  });

  it('renders role-specific notification bells with the signed-in unread count', async () => {
    const studentId = await userIdFor(STUDENT);
    const facultyId = await userIdFor(FACULTY);
    const adminId = await userIdFor('admin');
    const [studentPage, facultyPage, adminPage] = await Promise.all([
      student.get('/student'), faculty.get('/faculty'), admin.get('/admin'),
    ]);
    const expected = (n: number) => `Notifications, ${n ? `${n} unread` : 'no unread notifications'}`;
    expect(studentPage.text).toContain('href="/student/notices"');
    expect(facultyPage.text).toContain('href="/faculty/notices"');
    expect(adminPage.text).toContain('href="/admin/inbox"');
    expect(bellLabel(studentPage.text)).toBe(expected(await unreadFor(studentId)));
    expect(bellLabel(facultyPage.text)).toBe(expected(await unreadFor(facultyId)));
    expect(bellLabel(adminPage.text)).toBe(expected(await unreadFor(adminId)));
  });

  it('synchronizes persisted notification state across independent sessions', async () => {
    const studentId = await userIdFor(STUDENT);
    const secondSession = (await signIn(app, STUDENT.toLowerCase(), DEMO)).agent;
    const before = await student.get('/api/notifications/state');
    const facultyBefore = await faculty.get('/api/notifications/state');
    expect(before.status).toBe(200);
    expect(facultyBefore.status).toBe(200);
    expect(before.headers['cache-control']).toContain('no-store');

    const created = await db.query<{ id: number }>(
      `SELECT notify_user($1, '[test] Cross-device update', 'A persisted update shared by both sessions.',
         'Academic', '/student/notices', 'cross_device_test') AS id`, [studentId]);
    const notificationId = created.rows[0]!.id;

    const [firstState, secondState, board] = await Promise.all([
      student.get('/api/notifications/state'),
      secondSession.get('/api/notifications/state'),
      secondSession.get('/student/notices'),
    ]);
    expect(firstState.body.unread).toBe(before.body.unread + 1);
    expect(secondState.body).toEqual(firstState.body);
    expect(secondState.body.revision).not.toBe(before.body.revision);
    expect(board.text).toContain('[test] Cross-device update');
    expect((await faculty.get(`/faculty/notices/notification/${notificationId}`)).status).toBe(404);
    expect((await faculty.get('/api/notifications/state')).body).toEqual(facultyBefore.body);

    // Reading from one session changes the same server-backed row seen by the other.
    expect((await student.get(`/student/notices/notification/${notificationId}`)).status).toBe(200);
    const afterRead = await secondSession.get('/api/notifications/state');
    expect(afterRead.body.unread).toBe(before.body.unread);
    expect(afterRead.body.revision).not.toBe(firstState.body.revision);
    await db.query('DELETE FROM notification WHERE notification_id = $1', [notificationId]);
  });

  it('separates personal updates, marks linked notices read, and protects recipient counts', async () => {
    const studentId = await userIdFor(STUDENT);
    const facultyId = await userIdFor(FACULTY);
    const personal = await db.query<{ id: number }>(
      `SELECT notify_user($1, '[test] Bell personal', 'A private update with a destination.', 'General', '/student/grievances/1', 'grievance') AS id`, [studentId]);
    const personalId = personal.rows[0]!.id;
    const announcement = await db.query<{ id: number }>(
      `SELECT post_notice($1, '[test] Bell announcement', 'A regular announcement for the board.', 'Academic', '[{}]'::jsonb) AS id`, [await userIdFor('admin')]);
    const before = await unreadFor(studentId);
    const personalBoard = await student.get('/student/notices?kind=personal');
    expect(personalBoard.text).toContain('[test] Bell personal');
    expect(personalBoard.text).not.toContain('[test] Bell announcement');
    expect((await student.get('/student/notices?kind=announcements')).text).toContain('[test] Bell announcement');
    expect((await faculty.get('/faculty/notices?kind=personal')).text).not.toContain('[test] Bell personal');

    const go = await student.get(`/student/notices/notification/${personalId}/go`);
    expect(go.status).toBe(302);
    expect(go.headers.location).toBe('/student/grievances/1');
    expect(await unreadFor(studentId)).toBe(before - 1);
    expect((await faculty.get(`/faculty/notices/notification/${personalId}`)).status).toBe(404);

    const facultyPersonal = await db.query<{ id: number }>(
      `SELECT notify_user($1, '[test] Bell faculty personal', 'Only faculty should receive this.', 'General') AS id`, [facultyId]);
    expect((await student.get('/student/notices')).text).not.toContain('[test] Bell faculty personal');
    expect(await unreadFor(studentId)).toBe(before - 1);
    await db.query('DELETE FROM notification WHERE notification_id = $1', [facultyPersonal.rows[0]!.id]);
    const noLink = await db.query<{ id: number }>(
      `SELECT notify_user($1, '[test] Bell no link', 'This notification has no destination.', 'General') AS id`, [studentId]);
    const noLinkPage = await student.get(`/student/notices/notification/${noLink.rows[0]!.id}`);
    expect(noLinkPage.status).toBe(200);
    expect(noLinkPage.text).toContain('This notification has no destination.');
    await db.query('DELETE FROM notice WHERE notice_id = $1', [announcement.rows[0]!.id]);
    await db.query('DELETE FROM notification WHERE notification_id = $1', [noLink.rows[0]!.id]);
  });

  it('marks only the selected personal filter read', async () => {
    const studentId = await userIdFor(STUDENT);
    const personal = await db.query<{ id: number }>(
      `SELECT notify_user($1, '[test] Bell mark personal', 'Read this personal update.', 'General') AS id`, [studentId]);
    const announcement = await db.query<{ id: number }>(
      `SELECT post_notice($1, '[test] Bell mark announcement', 'Leave this announcement unread.', 'Academic', '[{}]'::jsonb) AS id`, [await userIdFor('admin')]);
    const cleared = await postForm(student, '/student/notices?kind=personal', '/student/notices/read-all', { kind: 'personal' });
    expect(cleared.headers.location).toBe('/student/notices?kind=personal');
    const states = await db.query<{ notice_id: number | null; notification_id: number | null; is_read: boolean }>(
      `SELECT notice_id, notification_id, is_read FROM v_user_notices WHERE user_id = $1
       AND ((item_type = 'notification' AND notification_id = ANY($2::int[])) OR (item_type = 'notice' AND notice_id = ANY($3::int[])))`,
      [studentId, [personal.rows[0]!.id], [announcement.rows[0]!.id]]);
    expect(states.rows.find((r) => r.notification_id === personal.rows[0]!.id)?.is_read).toBe(true);
    expect(states.rows.find((r) => r.notice_id === announcement.rows[0]!.id)?.is_read).toBe(false);
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

  it('shows live status alerts on the board and the dashboard', async () => {
    const short = await db.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM v_student_attendance_by_course v JOIN student s USING (student_id)
      WHERE s.student_number = $1 AND v.academic_session_id = current_session_id() AND v.eligibility = 'Shortage'`, [STUDENT]);
    const n = short.rows[0]!.n;
    const board = await student.get('/student/notices');
    if (n > 0) {
      expect(board.text).toContain('Needs your attention');
      expect(board.text).toContain(`Attendance below the minimum in ${n} course`);
      expect((await student.get('/student')).text).toContain(`Attendance below the minimum in ${n} course`);
    } else {
      expect(board.text).not.toContain('Needs your attention');
    }
  });

  it('a new grievance lands in the admin inbox and opens the grievance', async () => {
    const raised = await postForm(student, '/student/grievances/new', '/student/grievances', {
      category: 'Exam', subject: '[test] Marks missing', description: 'My in-sem marks for one course are missing.',
    });
    const gid = Number(/\/grievances\/(\d+)$/.exec(raised.headers.location ?? '')?.[1]);
    const inbox = await admin.get('/admin/inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.text).toContain(`New grievance #${gid}: [test] Marks missing`);
    const { rows } = await db.query<{ notification_id: number }>(
      `SELECT notification_id FROM notification WHERE link = $1 AND title LIKE 'New grievance%'`, [`/admin/grievances/${gid}`]);
    const go = await admin.get(`/admin/inbox/notification/${rows[0]!.notification_id}/go`);
    expect(go.status).toBe(302);
    expect(go.headers.location).toBe(`/admin/grievances/${gid}`);
    const read = await db.query('SELECT 1 FROM notification n JOIN app_user u USING (user_id) WHERE u.role = $1 AND n.notification_id = $2 AND n.read_at IS NOT NULL',
      ['admin', rows[0]!.notification_id]);
    expect(read.rows).toHaveLength(1);
    // the student cannot open the admin's personal notice
    expect((await student.get(`/student/notices/notification/${rows[0]!.notification_id}`)).status).toBe(404);
    // the admin's reply reaches the student as a personal notice
    await postForm(admin, `/admin/grievances/${gid}`, `/admin/grievances/${gid}/comments`, { body: 'Checking with the exam cell.' });
    expect((await student.get('/student/notices')).text).toContain(`New reply on grievance #${gid}`);
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
