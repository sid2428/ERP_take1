/**
 * HTTP tests for the T3-3 syllabus coverage pages: permissions and rendering.
 * They use the demo faculty and student accounts and change nothing in the database.
 */
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { hasAppEnv, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';

// the app reads its configuration on import, so only load it when the environment is set up
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAppEnv)('T3-3 syllabus coverage (pages and permissions)', () => {
  const app = createApp!();
  const db = pool!;

  afterAll(async () => {
    await db.end();
  });

  /** One class of the demo faculty member, and one class that belongs to somebody else. */
  async function classIds() {
    const { rows } = await db.query<{ own: number | null; other: number | null }>(`
      WITH me AS (SELECT faculty_id FROM faculty WHERE faculty_code = 'FAC-CSE-074')
      SELECT (SELECT min(assignment_id) FROM teaching_assignment WHERE faculty_id = (SELECT faculty_id FROM me)) AS own,
             (SELECT min(assignment_id) FROM teaching_assignment WHERE faculty_id <> (SELECT faculty_id FROM me)) AS other`);
    return rows[0]!;
  }

  it('sends signed-out visitors to the login page', async () => {
    const res = await request(app).get('/faculty/classes/1/syllabus');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  it('keeps students out of the faculty syllabus page', async () => {
    const { agent } = await signIn(app, 'STU202600004', DEMO);
    const ids = await classIds();
    expect((await agent.get(`/faculty/classes/${ids.own}/syllabus`)).status).toBe(403);
  });

  it('shows faculty the syllabus coverage of their own class', async () => {
    const { agent } = await signIn(app, 'FAC-CSE-074', DEMO);
    const ids = await classIds();
    expect(ids.own).not.toBeNull();
    const res = await agent.get(`/faculty/classes/${ids.own}/syllabus`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Syllabus coverage');
    expect(res.text).toContain('Planned');
    expect(res.text).toContain('Unit 1');
  });

  it('does not show faculty the syllabus of a class that is not theirs', async () => {
    const { agent } = await signIn(app, 'FAC-CSE-074', DEMO);
    const ids = await classIds();
    expect(ids.other).not.toBeNull();
    expect((await agent.get(`/faculty/classes/${ids.other}/syllabus`)).status).toBe(404);
  });

  it('adds a syllabus column to the faculty class list', async () => {
    const { agent } = await signIn(app, 'FAC-CSE-074', DEMO);
    const res = await agent.get('/faculty/classes');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<th>Syllabus</th>');
    expect(res.text).toContain('/syllabus');
  });

  it('shows students the syllabus covered for each course', async () => {
    const { agent } = await signIn(app, 'STU202600004', DEMO);
    const res = await agent.get('/student/offerings');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Syllabus covered');
    expect(res.text).toMatch(/\d of \d units done/);
  });
});
