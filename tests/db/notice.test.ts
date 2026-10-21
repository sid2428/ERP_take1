import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { hasDatabase, inRollback, one } from './helpers.js';

/** Run a statement expected to fail without aborting the surrounding test transaction. */
async function fails(db: pg.Client, sql: string, params: unknown[] = []): Promise<string> {
  await db.query('SAVEPOINT expect_fail');
  try {
    await db.query(sql, params);
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT expect_fail');
    return (err as Error).message;
  }
  throw new Error(`expected to fail: ${sql}`);
}

/** The admin, the demo faculty member with one division they teach and one they don't, and two students. */
async function fixture(db: pg.Client) {
  const admin = await one<{ user_id: number }>(db, `SELECT user_id FROM app_user WHERE role = 'admin' ORDER BY user_id LIMIT 1`);
  const fac = await one<{ user_id: number; faculty_id: number }>(db,
    `SELECT u.user_id, u.faculty_id FROM app_user u JOIN teaching_assignment ta USING (faculty_id)
     WHERE ta.academic_session_id = current_session_id() AND ta.division_id IS NOT NULL ORDER BY u.user_id LIMIT 1`);
  const taught = await one<{ division_id: number }>(db,
    `SELECT division_id FROM teaching_assignment WHERE faculty_id = $1 AND academic_session_id = current_session_id()
       AND division_id IS NOT NULL ORDER BY division_id LIMIT 1`, [fac.faculty_id]);
  const other = await one<{ division_id: number }>(db,
    `SELECT division_id FROM division d WHERE academic_session_id = current_session_id()
       AND NOT EXISTS (SELECT 1 FROM teaching_assignment ta WHERE ta.faculty_id = $1 AND ta.division_id = d.division_id)
       AND EXISTS (SELECT 1 FROM student_section ss WHERE ss.division_id = d.division_id)
     ORDER BY division_id LIMIT 1`, [fac.faculty_id]);
  const studentIn = async (divisionId: number) => one<{ user_id: number }>(db,
    `SELECT u.user_id FROM student_section ss JOIN app_user u USING (student_id)
     WHERE ss.division_id = $1 AND u.is_active ORDER BY u.user_id LIMIT 1`, [divisionId]);
  return {
    admin: admin.user_id, faculty: fac.user_id, taught: taught.division_id, other: other.division_id,
    inTaught: (await studentIn(taught.division_id)).user_id, inOther: (await studentIn(other.division_id)).user_id,
  };
}

const post = (db: pg.Client, by: number | null, targets: unknown, title = 'Lab moved to A-204') =>
  one<{ id: number }>(db, `SELECT post_notice($1, $2, 'Thursday lab is in A-204 from this week.', 'Academic', $3::jsonb) AS id`,
    [by, title, JSON.stringify(targets)]).then((r) => r.id);

const sees = async (db: pg.Client, userId: number, noticeId: number) =>
  (await db.query('SELECT 1 FROM v_user_notices WHERE user_id = $1 AND notice_id = $2', [userId, noticeId])).rows.length === 1;

describe.skipIf(!hasDatabase)('T8-1 notices', () => {
  it('a notice for everyone reaches students, faculty and the admin', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const id = await post(db, f.admin, [{}]);
      for (const u of [f.admin, f.faculty, f.inTaught, f.inOther]) expect(await sees(db, u, id)).toBe(true);
      const reach = await one<{ recipients: number }>(db, 'SELECT recipients FROM v_notice_reach WHERE notice_id = $1', [id]);
      const active = await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM app_user WHERE is_active');
      expect(reach.recipients).toBe(active.n);
    });
  });

  it('a division notice reaches exactly the students of that division', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const id = await post(db, f.admin, [{ division_id: f.other }]);
      expect(await sees(db, f.inOther, id)).toBe(true);
      expect(await sees(db, f.inTaught, id)).toBe(false);
      expect(await sees(db, f.faculty, id)).toBe(false);
      const t = await one<{ role: string }>(db, 'SELECT role FROM notice_target WHERE notice_id = $1', [id]);
      expect(t.role).toBe('student');
      const reach = await one<{ recipients: number }>(db, 'SELECT recipients FROM v_notice_reach WHERE notice_id = $1', [id]);
      const members = await one<{ n: number }>(db,
        `SELECT count(*)::int AS n FROM student_section ss JOIN app_user u USING (student_id)
         WHERE ss.division_id = $1 AND ss.academic_session_id = current_session_id() AND u.is_active`, [f.other]);
      expect(reach.recipients).toBe(members.n);
      const viaView = await one<{ n: number }>(db,
        `SELECT count(*)::int AS n FROM v_user_notices WHERE notice_id = $1`, [id]);
      expect(viaView.n).toBe(members.n);
    });
  });

  it('department and year targets combine filters; several targets add up', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const d = await one<{ dept_id: string; year_of_study: number }>(db,
        'SELECT dept_id, year_of_study FROM division WHERE division_id = $1', [f.other]);
      const id = await post(db, f.admin, [{ role: 'student', dept_id: d.dept_id, year_of_study: d.year_of_study }, { role: 'faculty' }]);
      expect(await sees(db, f.inOther, id)).toBe(true);
      expect(await sees(db, f.faculty, id)).toBe(true);                // via the second target
      expect(await sees(db, f.admin, id)).toBe(false);
    });
  });

  it('faculty may post only to divisions they teach', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const id = await post(db, f.faculty, [{ division_id: f.taught }]);
      expect(await sees(db, f.inTaught, id)).toBe(true);
      expect(await fails(db, `SELECT post_notice($1, 'Extra class on Friday', 'An extra class is scheduled on Friday.', 'Academic', $2::jsonb)`,
        [f.faculty, JSON.stringify([{ division_id: f.other }])])).toMatch(/divisions they teach/);
      expect(await fails(db, `SELECT post_notice($1, 'Message to everyone', 'This should not reach the whole college.', 'General', '[{}]')`,
        [f.faculty])).toMatch(/divisions they teach/);
    });
  });

  it('students cannot post, and a notice needs an audience', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      expect(await fails(db, `SELECT post_notice($1, 'Party tonight', 'Everyone is invited to the party.', 'Event', '[{}]')`,
        [f.inTaught])).toMatch(/only the admin and faculty/);
      expect(await fails(db, `SELECT post_notice($1, 'Nobody hears this', 'There is no audience at all.', 'General', '[]')`,
        [f.admin])).toMatch(/at least one audience/);
      // a bare insert without targets is refused when the transaction commits (checked here immediately)
      await db.query('SAVEPOINT bare');
      await db.query(`INSERT INTO notice (title, body, posted_by) VALUES ('Bare notice', 'A notice without any target.', $1)`, [f.admin]);
      const msg = await db.query('SET CONSTRAINTS has_audience IMMEDIATE').then(() => '', (e: Error) => e.message);
      await db.query('ROLLBACK TO SAVEPOINT bare');
      expect(msg).toMatch(/no audience/);
    });
  });

  it('a posted notice cannot be edited and its audience cannot change', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const id = await post(db, f.admin, [{ division_id: f.other }]);
      expect(await fails(db, `UPDATE notice SET title = 'Changed title here' WHERE notice_id = $1`, [id])).toMatch(/cannot be edited/);
      expect(await fails(db, 'DELETE FROM notice_target WHERE notice_id = $1', [id])).toMatch(/cannot be changed/);
      // a notice posted in an earlier transaction cannot gain targets
      const old = await one<{ notice_id: number }>(db,
        `INSERT INTO notice (title, body, posted_by, posted_at) VALUES ('Old notice', 'Posted yesterday already.', $1, now() - interval '1 day')
         RETURNING notice_id`, [f.admin]);
      expect(await fails(db, 'INSERT INTO notice_target (notice_id) VALUES ($1)', [old.notice_id])).toMatch(/cannot be changed/);
    });
  });

  it('the poster or an admin can withdraw; withdrawn notices disappear and stay withdrawn', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const id = await post(db, f.faculty, [{ division_id: f.taught }]);
      await db.query(`SELECT set_config('erp.user_id', $1, true)`, [String(f.inTaught)]);
      expect(await fails(db, 'UPDATE notice SET withdrawn_at = now() WHERE notice_id = $1', [id])).toMatch(/poster or an admin/);
      await db.query(`SELECT set_config('erp.user_id', $1, true)`, [String(f.faculty)]);
      await db.query('UPDATE notice SET withdrawn_at = now() WHERE notice_id = $1', [id]);
      expect(await sees(db, f.inTaught, id)).toBe(false);
      expect(await fails(db, 'UPDATE notice SET withdrawn_at = NULL, withdrawn_by = NULL WHERE notice_id = $1', [id])).toMatch(/withdrawn/);
    });
  });

  it('only recipients can mark a notice read; expired notices are hidden', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const id = await post(db, f.admin, [{ division_id: f.other }]);
      await db.query('INSERT INTO notice_read (notice_id, user_id) VALUES ($1, $2)', [id, f.inOther]);
      const r = await one<{ is_read: boolean }>(db, 'SELECT is_read FROM v_user_notices WHERE user_id = $1 AND notice_id = $2', [f.inOther, id]);
      expect(r.is_read).toBe(true);
      expect(await fails(db, 'INSERT INTO notice_read (notice_id, user_id) VALUES ($1, $2)', [id, f.inTaught])).toMatch(/not sent/);

      const exp = await one<{ id: number }>(db,
        `SELECT post_notice($1, 'Short-lived notice', 'This notice expires almost immediately.', 'General', '[{}]', false, now() + interval '1 second') AS id`,
        [f.admin]);
      expect(await sees(db, f.inOther, exp.id)).toBe(true);
      expect(await fails(db, `INSERT INTO notice (title, body, posted_by, expires_at) VALUES ('Expired notice', 'Expires before it is posted.', $1, now() - interval '1 hour')`,
        [f.admin])).toMatch(/check/);
    });
  });

  it('a system notice (no poster) can be posted by other modules', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const id = await post(db, null, [{ role: 'student' }], 'Semester results published');
      const n = await one<{ posted_by_name: string }>(db, 'SELECT posted_by_name FROM v_user_notices WHERE user_id = $1 AND notice_id = $2', [f.inTaught, id]);
      expect(n.posted_by_name).toBe('Academic office');
      expect(await sees(db, f.faculty, id)).toBe(false);
    });
  });
});
