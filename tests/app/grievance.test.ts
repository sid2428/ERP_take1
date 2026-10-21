/**
 * T8-2 (Grievances) page and permission tests: raise -> assign -> reply -> resolve / reject.
 * Test grievances have subjects starting with "[test]" and are removed afterwards.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const ADMIN = process.env.ADMIN_PASSWORD ?? '';
const FACULTY = 'FAC-CSE-074';

const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAppEnv)('T8-2 grievances (pages and permissions)', () => {
  const app = createApp!();
  const db = pool!;
  type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
  let admin: Agent;
  let student: Agent;
  let faculty: Agent;

  const cleanup = () => db.query(`DELETE FROM grievance WHERE subject LIKE '[test]%'`);
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
    const queue = await admin.get(`/admin/grievances?q=${id}`);
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

  it('faculty can raise grievances; others cannot read them; no self-assignment', async () => {
    const id = await raise(faculty, '/faculty/grievances', 'Lab chairs broken');
    expect((await student.get(`/student/grievances/${id}`)).status).toBe(404);
    const comment = await postForm(student, '/student/grievances', `/student/grievances/${id}/comments`, { body: 'Hello' });
    expect(comment.status).toBe(404);

    const res = await postForm(admin, `/admin/grievances/${id}`, `/admin/grievances/${id}/assign`, { faculty_code: FACULTY });
    expect(res.headers.location).toBe(`/admin/grievances/${id}`);
    expect(await row(id)).toMatchObject({ status: 'Open', assigned_code: null });
  });

  it('returns 404 for grievances that do not exist', async () => {
    expect((await admin.get('/admin/grievances/999999999')).status).toBe(404);
    const res = await postForm(admin, '/admin/grievances', '/admin/grievances/999999999/progress', {});
    expect(res.status).toBe(404);
  });
});
