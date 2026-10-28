/**
 * T8-2 (Grievances) page and permission tests: raise -> assign -> reply -> resolve / reject.
 * Test grievances have subjects starting with "[test]" and are removed afterwards.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAdminEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const ADMIN = process.env.ADMIN_PASSWORD ?? '';
const FACULTY = 'FAC-CSE-074';

const { createApp } = hasAdminEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAdminEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAdminEnv)('T8-2 grievances (pages and permissions)', () => {
  const app = hasAdminEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);
  const db = pool!;
  type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
  let admin: Agent;
  let student: Agent;
  let faculty: Agent;

  // test grievances and the personal notices and notifications their triggers posted
  const cleanup = async () => {
    await db.query(`DELETE FROM notice WHERE source = 'grievance' AND substring(link FROM '/grievances/([0-9]+)$')::int IN
                      (SELECT grievance_id FROM grievance WHERE subject LIKE '[test]%')`);
    await db.query(`DELETE FROM notification WHERE kind = 'grievance' AND substring(link FROM '/grievances/([0-9]+)$')::int IN
                      (SELECT grievance_id FROM grievance WHERE subject LIKE '[test]%')`);
    await db.query(`DELETE FROM grievance WHERE subject LIKE '[test]%'`);
  };
  const unread = async (agent: Agent) => ((await agent.get('/api/notifications/state')).body as { unread: number }).unread;
  const row = async (id: number) =>
    (await db.query<{ status: string; assigned_code: string | null; resolution_note: string | null }>(
      'SELECT status, assigned_code, resolution_note FROM v_grievance_overview WHERE grievance_id = $1', [id])).rows[0]!;
  const idFrom = (location: string | undefined) => Number(/\/grievances\/(\d+)$/.exec(location ?? '')?.[1]);

  /** Raise a grievance through the form and return its id. */
  async function raise(agent: Agent, base: string, subject: string): Promise<number> {
    const res = await postForm(agent, `${base}/new`, base, {
      category: 'Facilities', subject: `[test] ${subject}`, description: 'The projector in room A-101 has not worked for two weeks.',
    });
    expect(res.status).toBe(302);
    const id = idFrom(res.headers.location);
    expect(id).toBeGreaterThan(0);
    return id;
  }

  beforeAll(async () => {
    await cleanup();
    admin = (await signIn(app, 'admin', ADMIN)).agent;
    student = (await signIn(app, 'stu202600004', DEMO)).agent;
    faculty = (await signIn(app, FACULTY, DEMO)).agent;
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it('sends signed-out visitors to the login page', async () => {
    const res = await request(app).get('/student/grievances');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  it('keeps students and faculty out of the admin queue', async () => {
    expect([403, 404]).toContain((await student.get('/admin/grievances')).status);
    expect([403, 404]).toContain((await faculty.get('/admin/grievances')).status);
  });

  it('validates the form in the app', async () => {
    const res = await postForm(student, '/student/grievances/new', '/student/grievances',
      { category: 'Facilities', subject: '[test]', description: 'short' });
    expect(res.headers.location).toBe('/student/grievances/new');
    const { rows } = await db.query(`SELECT 1 FROM grievance WHERE subject = '[test]'`);
    expect(rows).toHaveLength(0);
  });

  it('runs the full flow: raise, assign, reply, resolve', async () => {
    const id = await raise(student, '/student/grievances', 'Projector broken');
    expect((await row(id)).status).toBe('Open');

    // the student sees it; the admin queue shows it straight away
    expect((await student.get('/student/grievances')).text).toContain('[test] Projector broken');
    const queue = await admin.get(`/admin/grievances?view=general&q=${id}`);
    expect(queue.status).toBe(200);
    expect(queue.text).toContain(`/admin/grievances/${id}`);

    // faculty cannot see it until it is assigned to them
    expect((await faculty.get(`/faculty/grievances/${id}`)).status).toBe(404);

    await postForm(admin, `/admin/grievances/${id}`, `/admin/grievances/${id}/assign`, { faculty_code: FACULTY.toLowerCase() });
    expect(await row(id)).toMatchObject({ status: 'In progress', assigned_code: FACULTY });

    const list = await faculty.get('/faculty/grievances');
    expect(list.text).toContain('Assigned to me');
    expect(list.text).toContain(`/faculty/grievances/${id}`);
    await postForm(faculty, `/faculty/grievances/${id}`, `/faculty/grievances/${id}/comments`, { body: 'Technician booked for Thursday.' });
    await postForm(student, `/student/grievances/${id}`, `/student/grievances/${id}/comments`, { body: 'Thank you.' });
    const detail = await student.get(`/student/grievances/${id}`);
    expect(detail.text).toContain('Technician booked for Thursday.');
    expect(detail.text).toContain('Thank you.');

    // a decision needs a note
    await postForm(admin, `/admin/grievances/${id}`, `/admin/grievances/${id}/resolve`, { outcome: 'Resolved', note: '' });
    expect((await row(id)).status).toBe('In progress');

    await postForm(admin, `/admin/grievances/${id}`, `/admin/grievances/${id}/resolve`, { outcome: 'Resolved', note: 'Projector replaced on 21 Oct.' });
    expect(await row(id)).toMatchObject({ status: 'Resolved', resolution_note: 'Projector replaced on 21 Oct.' });
    expect((await student.get(`/student/grievances/${id}`)).text).toContain('Projector replaced on 21 Oct.');

    // closed: further replies are refused by the database
    const late = await postForm(student, `/student/grievances/${id}`, `/student/grievances/${id}/comments`, { body: 'One more thing' });
    expect(late.status).toBe(302);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM grievance_comment WHERE grievance_id = $1`, [id]);
    expect(rows[0].n).toBe(2);

    const auditRows = await db.query(
      `SELECT action FROM audit_log WHERE entity = 'grievance' AND entity_id = $1 ORDER BY audit_id`, [String(id)]);
    expect(auditRows.rows.map((r) => r.action)).toEqual(
      ['GRIEVANCE_CREATE', 'GRIEVANCE_ASSIGN', 'GRIEVANCE_COMMENT', 'GRIEVANCE_COMMENT', 'GRIEVANCE_RESOLVE']);
  });

  it('lets the admin reject a grievance', async () => {
    const id = await raise(student, '/student/grievances', 'Wrong category');
    await postForm(admin, `/admin/grievances/${id}`, `/admin/grievances/${id}/progress`, {});
    expect((await row(id)).status).toBe('In progress');
    await postForm(admin, `/admin/grievances/${id}`, `/admin/grievances/${id}/resolve`, { outcome: 'Rejected', note: 'Please raise this with the exam cell.' });
    expect((await row(id)).status).toBe('Rejected');
  });

  it('tells the admin in the app when a faculty member raises a grievance', async () => {
    const before = await unread(admin);
    const id = await raise(faculty, '/faculty/grievances', 'Staff room AC broken');
    expect(await unread(admin)).toBe(before + 1);
    const inbox = await admin.get('/admin/inbox');
    // the inbox item opens the grievance (and marks the notification read)
    const go = new RegExp(`href="([^"]+/go)">New grievance #${id}:`).exec(inbox.text)?.[1];
    expect(go).toBeTruthy();
    expect((await admin.get(go!)).headers.location).toBe(`/admin/grievances/${id}`);
    expect(await unread(admin)).toBe(before);
    // the default "by teacher" view points the admin to the general queue, where it is listed
    const byTeacher = await admin.get('/admin/grievances');
    expect(byTeacher.text).toMatch(/raised by faculty/);
    expect((await admin.get('/admin/grievances?view=general')).text).toContain(`/admin/grievances/${id}`);
  });

  it('faculty can raise grievances; others cannot read them; no self-assignment', async () => {
    const id = await raise(faculty, '/faculty/grievances', 'Lab chairs broken');
    expect((await student.get(`/student/grievances/${id}`)).status).toBe(404);
    const comment = await postForm(student, '/student/grievances', `/student/grievances/${id}/comments`, { body: 'Hello' });
    expect(comment.status).toBe(404);

    const res = await postForm(admin, `/admin/grievances/${id}`, `/admin/grievances/${id}/assign`, { faculty_code: FACULTY });
    expect(res.headers.location).toBe(`/admin/grievances/${id}`);
    expect(await row(id)).toMatchObject({ status: 'Open', assigned_code: null });
  });

  it('sends a course grievance to the course teacher, who closes it; only the admin can unlock it', async () => {
    const { rows: [course] } = await db.query<{ course_id: number }>(`
      SELECT ta.course_id FROM app_user u
      JOIN v_assignment_roster r ON r.student_id = u.student_id
      JOIN teaching_assignment ta USING (assignment_id)
      JOIN faculty f ON f.faculty_id = ta.faculty_id
      WHERE u.login_id = 'STU202600004' AND f.faculty_code = $1 AND ta.academic_session_id = current_session_id()
      LIMIT 1`, [FACULTY]);
    expect(course).toBeDefined();
    expect((await student.get('/student/grievances/new')).text).toContain(`<option value="${course!.course_id}"`);

    // no teacher chosen: the one teaching the course is filled in
    const res = await postForm(student, '/student/grievances/new', '/student/grievances', {
      about: 'course', course_id: String(course!.course_id), faculty_id: '', category: 'Exam',
      subject: '[test] Internal marks missing', description: 'My internal marks for the first test are missing.',
    });
    const id = idFrom(res.headers.location);
    expect(await row(id)).toMatchObject({ status: 'Open', assigned_code: FACULTY });

    // the admin finds it under the teacher, not in the general queue
    expect((await admin.get(`/admin/grievances?view=general&q=${id}`)).text).not.toContain(`/admin/grievances/${id}"`);
    expect((await admin.get(`/admin/grievances?faculty=${FACULTY}`)).text).toContain(`/admin/grievances/${id}"`);

    // the teacher sees it and closes it with a note, which locks it
    expect((await faculty.get('/faculty/grievances')).text).toContain(`/faculty/grievances/${id}`);
    await postForm(faculty, `/faculty/grievances/${id}`, `/faculty/grievances/${id}/resolve`, { outcome: 'Rejected', note: '' });
    expect((await row(id)).status).toBe('Open');
    await postForm(faculty, `/faculty/grievances/${id}`, `/faculty/grievances/${id}/resolve`,
      { outcome: 'Rejected', note: 'Marks were entered on 20 Oct.' });
    expect(await row(id)).toMatchObject({ status: 'Rejected', resolution_note: 'Marks were entered on 20 Oct.' });
    expect((await student.get(`/student/grievances/${id}`)).text).toContain('Marks were entered on 20 Oct.');

    // the student cannot use the teacher's actions
    const own = await postForm(student, `/student/grievances/${id}`, `/student/grievances/${id}/resolve`,
      { outcome: 'Resolved', note: 'Fixed it myself' });
    expect(own.status).toBe(404);

    // the admin unlocks it, with a reason
    await postForm(admin, `/admin/grievances/${id}`, `/admin/grievances/${id}/unlock`, { reason: '' });
    expect((await row(id)).status).toBe('Rejected');
    await postForm(admin, `/admin/grievances/${id}`, `/admin/grievances/${id}/unlock`, { reason: 'Student shows the marks are still missing.' });
    expect(await row(id)).toMatchObject({ status: 'In progress', resolution_note: null, assigned_code: FACULTY });
    expect((await student.get(`/student/grievances/${id}`)).text).toContain('Student shows the marks are still missing.');
  });

  it('returns 404 for grievances that do not exist', async () => {
    expect((await admin.get('/admin/grievances/999999999')).status).toBe(404);
    const res = await postForm(admin, '/admin/grievances', '/admin/grievances/999999999/progress', {});
    expect(res.status).toBe(404);
  });
});
