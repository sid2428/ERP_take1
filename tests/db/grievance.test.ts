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

/** A student with a course teacher this term, that teacher, another faculty member, and the admin. */
async function courseFixture(db: pg.Client) {
  const t = await one<{ student: number; course_id: number; faculty_id: number; teacher: number }>(db, `
    SELECT u.user_id AS student, ta.course_id, ta.faculty_id, fu.user_id AS teacher
    FROM app_user u
    JOIN v_assignment_roster r ON r.student_id = u.student_id
    JOIN teaching_assignment ta USING (assignment_id)
    JOIN faculty f ON f.faculty_id = ta.faculty_id AND f.status = 'Active'
    JOIN app_user fu ON fu.faculty_id = ta.faculty_id AND fu.is_active
    WHERE u.is_active AND ta.academic_session_id = current_session_id()
    ORDER BY u.user_id, ta.assignment_id LIMIT 1`);
  const other = await one<{ user_id: number; faculty_id: number }>(db, `
    SELECT u.user_id, u.faculty_id FROM app_user u JOIN faculty f USING (faculty_id)
    WHERE f.status = 'Active' AND u.is_active AND u.faculty_id <> $1
      AND NOT teaches_student(u.faculty_id, (SELECT student_id FROM app_user WHERE user_id = $2), $3)
    ORDER BY u.user_id LIMIT 1`, [t.faculty_id, t.student, t.course_id]);
  const admin = await one<{ user_id: number }>(db, `SELECT user_id FROM app_user WHERE role = 'admin' AND is_active ORDER BY user_id LIMIT 1`);
  const g = await one<{ grievance_id: number }>(db,
    `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description, course_id, assigned_to)
     VALUES ($1, 'student', 'Exam', 'Internal marks look wrong', 'My internal marks are lower than what was announced.', $2, $3)
     RETURNING grievance_id`, [t.student, t.course_id, t.faculty_id]);
  return { ...t, other, admin: admin.user_id, id: g.grievance_id };
}

const notices = (db: pg.Client, id: number) => db.query<{ user_id: number; role: string; text: string }>(
  `SELECT n.user_id, u.role::text AS role, n.text FROM notification n JOIN app_user u USING (user_id)
   WHERE n.kind = 'grievance' AND n.link LIKE '%/grievances/' || $1 ORDER BY n.notification_id`, [id]);

describe.skipIf(!hasDatabase)('094 course grievances', () => {
  it('goes straight to the course teacher, who is notified instead of the admins', async () => {
    await inRollback(async (db) => {
      const f = await courseFixture(db);
      const g = await one<{ status: string; assigned_to: number; assigned_at: Date | null; course_code: string }>(db,
        'SELECT status, assigned_to, assigned_at, course_code FROM v_grievance_overview WHERE grievance_id = $1', [f.id]);
      expect(g).toMatchObject({ status: 'Open', assigned_to: f.faculty_id });
      expect(g.assigned_at).not.toBeNull();
      expect(g.course_code).toBeTruthy();
      const sent = (await notices(db, f.id)).rows;
      expect(sent.map((n) => n.user_id)).toEqual([f.teacher]);
      expect(await one<{ ok: boolean }>(db, 'SELECT grievance_participant($1, $2) AS ok', [f.teacher, f.id])).toEqual({ ok: true });
    });
  });

  it('must go to a teacher who teaches the student that course, and only students raise them', async () => {
    await inRollback(async (db) => {
      const f = await courseFixture(db);
      expect(await fails(db,
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description, course_id, assigned_to)
         VALUES ($1, 'student', 'Exam', 'Wrong teacher', 'This teacher does not teach me.', $2, $3)`,
        [f.student, f.course_id, f.other.faculty_id])).toMatch(/teacher who teaches you/);
      expect(await fails(db,
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description, course_id)
         VALUES ($1, 'student', 'Exam', 'No teacher', 'Nobody was chosen for this one.', $2)`,
        [f.student, f.course_id])).toMatch(/teacher who teaches you/);
      expect(await fails(db,
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description, course_id, assigned_to)
         VALUES ($1, 'faculty', 'Exam', 'Faculty course grievance', 'Faculty do not raise course grievances.', $2, $3)`,
        [f.other.user_id, f.course_id, f.faculty_id])).toMatch(/only students/);
      expect(await fails(db, 'CALL assign_grievance($1, NULL, $2)', [f.id, f.admin])).toMatch(/always has a teacher/);
    });
  });

  it('the assigned teacher closes it; another teacher cannot', async () => {
    await inRollback(async (db) => {
      const f = await courseFixture(db);
      expect(await fails(db, `CALL resolve_grievance($1, $2, 'Resolved', 'Not my course though')`, [f.id, f.other.user_id]))
        .toMatch(/only the assigned teacher or an admin/);
      expect(await fails(db, `CALL resolve_grievance($1, $2, 'Resolved', 'I am the student')`, [f.id, f.student]))
        .toMatch(/only the assigned teacher or an admin/);
      await db.query(`CALL resolve_grievance($1, $2, 'Rejected', 'Marks match the answer sheet.')`, [f.id, f.teacher]);
      expect(await status(db, f.id)).toMatchObject({ status: 'Rejected', resolved_by: f.teacher });
      // the student is told; the teacher is not told about their own decision
      expect((await notices(db, f.id)).rows.at(-1)).toMatchObject({ user_id: f.student });
    });
  });

  it('a closed grievance is locked until an admin unlocks it with a reason', async () => {
    await inRollback(async (db) => {
      const f = await courseFixture(db);
      await db.query(`CALL resolve_grievance($1, $2, 'Rejected', 'Marks match the answer sheet.')`, [f.id, f.teacher]);
      expect(await fails(db, COMMENT_SQL, [f.id, f.student, 'I disagree'])).toMatch(/closed/);
      expect(await fails(db, 'CALL unlock_grievance($1, $2, $3)', [f.id, f.teacher, 'Teacher wants to reopen'])).toMatch(/only an admin/);
      expect(await fails(db, 'CALL unlock_grievance($1, $2, $3)', [f.id, f.admin, ' '])).toMatch(/reason/);
      await db.query(`SELECT set_config('erp.user_id', $1, true)`, [String(f.teacher)]);
      expect(await fails(db, `UPDATE grievance SET status = 'In progress' WHERE grievance_id = $1`, [f.id])).toMatch(/only an admin can unlock/);

      await db.query('CALL unlock_grievance($1, $2, $3)', [f.id, f.admin, 'Student shared the re-evaluation receipt.']);
      expect(await one(db, 'SELECT status, resolved_at, resolved_by, resolution_note, assigned_to FROM grievance WHERE grievance_id = $1', [f.id]))
        .toEqual({ status: 'In progress', resolved_at: null, resolved_by: null, resolution_note: null, assigned_to: f.faculty_id });
      expect(await fails(db, 'CALL unlock_grievance($1, $2, $3)', [f.id, f.admin, 'Unlock it twice'])).toMatch(/not locked/);

      // the conversation continues and it can be closed again; both decisions stay in the log
      await comment(db, f.id, f.student, 'Here is the receipt.');
      await db.query(`CALL resolve_grievance($1, $2, 'Resolved', 'Marks corrected after re-evaluation.')`, [f.id, f.teacher]);
      const log = (await db.query(
        'SELECT from_status, to_status, changed_by, note FROM grievance_status_log WHERE grievance_id = $1 ORDER BY log_id', [f.id])).rows;
      expect(log).toEqual([
        { from_status: null, to_status: 'Open', changed_by: f.student, note: null },
        { from_status: 'Open', to_status: 'Rejected', changed_by: f.teacher, note: 'Marks match the answer sheet.' },
        { from_status: 'Rejected', to_status: 'In progress', changed_by: f.admin, note: 'Student shared the re-evaluation receipt.' },
        { from_status: 'In progress', to_status: 'Resolved', changed_by: f.teacher, note: 'Marks corrected after re-evaluation.' },
      ]);
      const toStudent = (await notices(db, f.id)).rows.filter((n) => n.user_id === f.student).map((n) => n.text.split('\n')[0]);
      expect(toStudent).toEqual([
        `Your grievance #${f.id} was rejected`, `Your grievance #${f.id} was reopened`, `Your grievance #${f.id} was resolved`,
      ]);
    });
  });

  it('admins can unlock general grievances too', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await db.query(`CALL resolve_grievance($1, $2, 'Resolved', 'Projector replaced on 21 Oct.')`, [f.id, f.admin]);
      await db.query('CALL unlock_grievance($1, $2, $3)', [f.id, f.admin, 'Projector failed again.']);
      expect((await status(db, f.id)).status).toBe('In progress');
    });
  });

  it('replies on a course grievance are not sent to the admins', async () => {
    await inRollback(async (db) => {
      const f = await courseFixture(db);
      await comment(db, f.id, f.student, 'Any update?');
      await comment(db, f.id, f.teacher, 'Checking the answer sheet today.');
      const roles = (await notices(db, f.id)).rows.map((n) => n.role);
      expect(roles).not.toContain('admin');
      expect(roles.filter((r) => r === 'student')).toHaveLength(1);
    });
  });
});
