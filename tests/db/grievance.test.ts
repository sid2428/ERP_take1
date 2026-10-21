import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { hasDatabase, inRollback, one } from './helpers.js';

/** A student, two faculty and the admin account, plus one fresh Open grievance raised by the student. */
async function fixture(db: pg.Client) {
  const stu = await one<{ user_id: number }>(db,
    `SELECT u.user_id FROM app_user u JOIN student s USING (student_id) WHERE s.status = 'Active' ORDER BY u.user_id LIMIT 1`);
  const fac = (await db.query<{ user_id: number; faculty_id: number }>(
    `SELECT u.user_id, u.faculty_id FROM app_user u JOIN faculty f USING (faculty_id)
     WHERE f.status = 'Active' ORDER BY u.user_id LIMIT 2`)).rows;
  const admin = await one<{ user_id: number }>(db, `SELECT user_id FROM app_user WHERE role = 'admin' ORDER BY user_id LIMIT 1`);
  const g = await one<{ grievance_id: number }>(db,
    `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description)
     VALUES ($1, 'student', 'Facilities', 'Projector broken in A-101', 'The projector has not worked for two weeks.')
     RETURNING grievance_id`, [stu.user_id]);
  return { student: stu.user_id, fac1: fac[0]!, fac2: fac[1]!, admin: admin.user_id, id: g.grievance_id };
}

const status = (db: pg.Client, id: number) =>
  one<{ status: string; resolved_at: Date | null; assigned_at: Date | null; resolved_by: number | null }>(db,
    'SELECT status, resolved_at, assigned_at, resolved_by FROM grievance WHERE grievance_id = $1', [id]);

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

const COMMENT_SQL = 'INSERT INTO grievance_comment (grievance_id, author_id, body) VALUES ($1, $2, $3)';
const comment = (db: pg.Client, id: number, author: number, body = 'Any update on this?') =>
  db.query('INSERT INTO grievance_comment (grievance_id, author_id, body) VALUES ($1, $2, $3)', [id, author, body]);

describe.skipIf(!hasDatabase)('T8-2 grievances', () => {
  it('starts Open and logs the first status', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      expect((await status(db, f.id)).status).toBe('Open');
      const log = await db.query('SELECT from_status, to_status, changed_by FROM grievance_status_log WHERE grievance_id = $1', [f.id]);
      expect(log.rows).toEqual([{ from_status: null, to_status: 'Open', changed_by: f.student }]);
    });
  });

  it('rejects a grievance whose stored role is not the account role, and admin-raised grievances', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      expect(await fails(db,
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description)
         VALUES ($1, 'faculty', 'Other', 'Wrong role here', 'This should not be accepted.')`, [f.student])).toMatch(/foreign key/);
      expect(await fails(db,
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description)
         VALUES ($1, 'admin', 'Other', 'Admin grievance', 'Admins do not raise grievances.')`, [f.admin])).toMatch(/check/);
    });
  });

  it('cannot be created already resolved', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      expect(await fails(db,
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description, status)
         VALUES ($1, 'student', 'Other', 'Sneaky resolved', 'Inserted directly as resolved.', 'Resolved')`, [f.student])).toMatch(/must be Open/);
    });
  });

  it('assigning a faculty member moves it to In progress and stamps the time', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await db.query('CALL assign_grievance($1, $2, $3)', [f.id, f.fac1.faculty_id, f.admin]);
      const g = await status(db, f.id);
      expect(g.status).toBe('In progress');
      expect(g.assigned_at).not.toBeNull();
      const log = await one<{ to_status: string; changed_by: number }>(db,
        `SELECT to_status, changed_by FROM grievance_status_log WHERE grievance_id = $1 AND from_status = 'Open'`, [f.id]);
      expect(log).toEqual({ to_status: 'In progress', changed_by: f.admin });
    });
  });

  it('cannot be assigned to the faculty member who raised it', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const own = await one<{ grievance_id: number }>(db,
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description)
         VALUES ($1, 'faculty', 'Other', 'Lab chairs broken', 'Several lab chairs are broken.') RETURNING grievance_id`,
        [f.fac1.user_id]);
      expect(await fails(db, 'CALL assign_grievance($1, $2, $3)', [own.grievance_id, f.fac1.faculty_id, f.admin])).toMatch(/person who raised it/);
    });
  });

  it('only an admin can assign or close', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      expect(await fails(db, 'CALL assign_grievance($1, $2, $3)', [f.id, f.fac1.faculty_id, f.student])).toMatch(/only an admin/);
      expect(await fails(db, `CALL resolve_grievance($1, $2, 'Resolved', 'Fixed it myself')`, [f.id, f.fac1.user_id])).toMatch(/only an admin/);
      // a direct UPDATE without an admin behind it is refused too
      expect(await fails(db, `UPDATE grievance SET status = 'Resolved', resolution_note = 'Done and dusted' WHERE grievance_id = $1`, [f.id])).toMatch(/only an admin/);
    });
  });

  it('resolving stamps time and admin; a note is required', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      expect(await fails(db, `CALL resolve_grievance($1, $2, 'Resolved', '  ')`, [f.id, f.admin])).toMatch(/check/);
      await db.query(`CALL resolve_grievance($1, $2, 'Resolved', 'Projector replaced on 21 Oct.')`, [f.id, f.admin]);
      const g = await status(db, f.id);
      expect(g.status).toBe('Resolved');
      expect(g.resolved_at).not.toBeNull();
      expect(g.resolved_by).toBe(f.admin);
    });
  });

  it('rejects a close to a non-final status', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      expect(await fails(db, `CALL resolve_grievance($1, $2, 'In progress', 'Working on it now')`, [f.id, f.admin])).toMatch(/Resolved or Rejected/);
    });
  });

  it('a closed grievance is frozen: no changes, no comments', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await db.query(`CALL resolve_grievance($1, $2, 'Rejected', 'Not a facilities issue; raise it with the exam cell.')`, [f.id, f.admin]);
      expect(await fails(db, `UPDATE grievance SET status = 'Open' WHERE grievance_id = $1`, [f.id])).toMatch(/already rejected/);
      expect(await fails(db, `UPDATE grievance SET category = 'Exam' WHERE grievance_id = $1`, [f.id])).toMatch(/already rejected/);
      expect(await fails(db, COMMENT_SQL, [f.id, f.student, 'Any update on this?'])).toMatch(/closed/);
    });
  });

  it('what the raiser wrote cannot be edited', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      expect(await fails(db, `UPDATE grievance SET description = 'Changed my story entirely.' WHERE grievance_id = $1`, [f.id])).toMatch(/cannot be changed/);
    });
  });

  it('In progress cannot go back to Open', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await db.query('CALL assign_grievance($1, $2, $3)', [f.id, f.fac1.faculty_id, f.admin]);
      expect(await fails(db, `UPDATE grievance SET status = 'Open' WHERE grievance_id = $1`, [f.id])).toMatch(/cannot go from/);
    });
  });

  it('only participants can comment', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await comment(db, f.id, f.student);
      await comment(db, f.id, f.admin, 'Looking into it.');
      expect(await fails(db, COMMENT_SQL, [f.id, f.fac1.user_id, 'Any update on this?'])).toMatch(/only the raiser/);    // not assigned yet
      await db.query('CALL assign_grievance($1, $2, $3)', [f.id, f.fac1.faculty_id, f.admin]);
      await comment(db, f.id, f.fac1.user_id, 'Technician booked for Thursday.');
      expect(await fails(db, COMMENT_SQL, [f.id, f.fac2.user_id, 'Any update on this?'])).toMatch(/only the raiser/);
      const n = await one<{ comment_count: number }>(db, 'SELECT comment_count FROM v_grievance_overview WHERE grievance_id = $1', [f.id]);
      expect(n.comment_count).toBe(3);
    });
  });

  it('participant check matches raiser, assignee and admin', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await db.query('CALL assign_grievance($1, $2, $3)', [f.id, f.fac1.faculty_id, f.admin]);
      const check = async (u: number) =>
        (await one<{ ok: boolean }>(db, 'SELECT grievance_participant($1, $2) AS ok', [u, f.id])).ok;
      expect(await check(f.student)).toBe(true);
      expect(await check(f.admin)).toBe(true);
      expect(await check(f.fac1.user_id)).toBe(true);
      expect(await check(f.fac2.user_id)).toBe(false);
    });
  });

  it('resolution stats list every category and count the new grievance', async () => {
    await inRollback(async (db) => {
      const before = await one<{ total: number }>(db, `SELECT total FROM v_grievance_resolution_stats WHERE category = 'Facilities'`);
      const f = await fixture(db);
      await db.query(`CALL resolve_grievance($1, $2, 'Resolved', 'Projector replaced.')`, [f.id, f.admin]);
      const rows = (await db.query('SELECT category, total, resolved FROM v_grievance_resolution_stats')).rows;
      expect(rows.map((r) => r.category)).toEqual(['Academic', 'Attendance', 'Fees', 'Exam', 'Facilities', 'Other']);
      expect(rows.find((r) => r.category === 'Facilities')!.total).toBe(before.total + 1);
    });
  });
});
