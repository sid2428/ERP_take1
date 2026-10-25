/**
 * T3 (Academic) page and permission tests: elective selection.
 * Test windows use semester 12, which no real window uses, and are removed afterwards.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const ADMIN = process.env.ADMIN_PASSWORD ?? '';

// the app reads its configuration on import, so only load it when the environment is set up
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAppEnv)('T3 electives (pages and permissions)', () => {
  const app = hasAppEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);
  const db = pool!;
  let admin: Awaited<ReturnType<typeof signIn>>['agent'];
  let student: Awaited<ReturnType<typeof signIn>>['agent'];
  let sessionId = '';

  const cleanup = () => db.query('DELETE FROM elective_window WHERE semester_no = 12');

  beforeAll(async () => {
    await cleanup();
    admin = (await signIn(app, 'admin', ADMIN)).agent;
    student = (await signIn(app, 'stu202600004', DEMO)).agent;
    const { rows } = await db.query<{ session_id: string }>('SELECT current_session_id() AS session_id');
    sessionId = rows[0]!.session_id;
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it('sends signed-out visitors to the login page', async () => {
    const res = await request(app).get('/admin/electives');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  it('keeps students out of the admin elective pages', async () => {
    const page = await student.get('/admin/electives');
    expect([403, 404]).toContain(page.status);
    const post = await postForm(student, '/student/profile', '/admin/electives', {
      academic_session_id: sessionId, semester_no: '12', elective_group: 'H1',
      opens_at: '2026-01-01T09:00', closes_at: '2026-01-02T09:00', max_choices: '3',
    });
    expect([403, 404]).toContain(post.status);
    const { rows } = await db.query('SELECT 1 FROM elective_window WHERE semester_no = 12');
    expect(rows).toHaveLength(0);
  });

  it('shows the admin elective windows page', async () => {
    const res = await admin.get('/admin/electives');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Elective windows');
  });

  it('shows students their elective page', async () => {
    const res = await student.get('/student/electives');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Elective selection');
  });

  it('lets the admin create a window but refuses to open one with no offerings', async () => {
    const created = await postForm(admin, '/admin/electives', '/admin/electives', {
      academic_session_id: sessionId, semester_no: '12', elective_group: 'H1',
      opens_at: '2026-01-01T09:00', closes_at: '2026-01-02T09:00', max_choices: '3',
    });
    expect(created.status).toBe(302);
    expect(created.headers.location).toMatch(/^\/admin\/electives\/\d+$/);

    const detail = await admin.get(created.headers.location!);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('Honors');

    const opened = await postForm(admin, created.headers.location!, `${created.headers.location}/open`, {});
    expect(opened.status).toBe(302);
    const { rows } = await db.query<{ status: string }>('SELECT status FROM elective_window WHERE semester_no = 12');
    expect(rows[0]?.status).toBe('Scheduled');
  });

  it('rejects a window that closes before it opens', async () => {
    const res = await postForm(admin, '/admin/electives', '/admin/electives', {
      academic_session_id: sessionId, semester_no: '12', elective_group: 'O1',
      opens_at: '2026-01-02T09:00', closes_at: '2026-01-01T09:00', max_choices: '3',
    });
    expect(res.status).toBe(302);
    const { rows } = await db.query(`SELECT 1 FROM elective_window WHERE semester_no = 12 AND elective_group = 'O1'`);
    expect(rows).toHaveLength(0);
  });

  it('does not let a student save choices for a window that is not theirs', async () => {
    const { rows } = await db.query<{ window_id: number }>('SELECT window_id FROM elective_window WHERE semester_no = 12');
    const res = await postForm(student, '/student/electives', `/student/electives/${rows[0]!.window_id}`, { choice1: '1' });
    expect(res.status).toBe(404);
    const saved = await db.query('SELECT 1 FROM elective_preference WHERE window_id = $1', [rows[0]!.window_id]);
    expect(saved.rows).toHaveLength(0);
  });
});
