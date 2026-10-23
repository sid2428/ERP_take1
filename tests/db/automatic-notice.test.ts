import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { hasDatabase, inRollback, one } from './helpers.js';

/** Personal notices a user can see, newest first. */
const inbox = async (db: pg.Client, userId: number) =>
  (await db.query<{ title: string; body: string; link: string | null }>(
    `SELECT title, body, link FROM v_user_notices WHERE user_id = $1 AND is_personal
     ORDER BY COALESCE(notification_id, notice_id) DESC`, [userId])).rows;

async function people(db: pg.Client) {
  const student = await one<{ user_id: number; student_id: number }>(db,
    `SELECT u.user_id, u.student_id FROM app_user u JOIN student s USING (student_id)
     WHERE s.status = 'Active' AND u.is_active ORDER BY u.user_id LIMIT 1`);
  const other = await one<{ user_id: number }>(db,
    `SELECT u.user_id FROM app_user u WHERE u.role = 'student' AND u.is_active AND u.user_id <> $1 ORDER BY u.user_id LIMIT 1`, [student.user_id]);
  const fac = await one<{ user_id: number; faculty_id: number }>(db,
    `SELECT u.user_id, u.faculty_id FROM app_user u JOIN faculty f USING (faculty_id) WHERE f.status = 'Active' ORDER BY u.user_id LIMIT 1`);
  const admin = await one<{ user_id: number }>(db, `SELECT user_id FROM app_user WHERE role = 'admin' ORDER BY user_id LIMIT 1`);
  return { student, other: other.user_id, fac, admin: admin.user_id };
}

describe.skipIf(!hasDatabase)('T8 automatic notices', () => {
  it('grievance events notify the right people, and only them', async () => {
    await inRollback(async (db) => {
      const p = await people(db);
      const g = await one<{ grievance_id: number }>(db,
        `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description)
         VALUES ($1, 'student', 'Fees', 'Payment shown as due', 'I paid the first installment but it still shows as due.')
         RETURNING grievance_id`, [p.student.user_id]);
      const id = g.grievance_id;

      // raised -> the admin hears about it
      expect((await inbox(db, p.admin))[0]).toMatchObject({ title: `New grievance #${id}: Payment shown as due`, link: `/admin/grievances/${id}` });

      // assigned -> the faculty member and the raiser
      await db.query('CALL assign_grievance($1, $2, $3)', [id, p.fac.faculty_id, p.admin]);
      expect((await inbox(db, p.fac.user_id))[0]).toMatchObject({ title: `Grievance #${id} assigned to you`, link: `/faculty/grievances/${id}` });
      expect((await inbox(db, p.student.user_id))[0]!.title).toBe(`Your grievance #${id} is being handled`);

      // the admin replies -> raiser and assignee, not the admin
      const adminBefore = (await inbox(db, p.admin)).length;
      await db.query('INSERT INTO grievance_comment (grievance_id, author_id, body) VALUES ($1, $2, $3)',
        [id, p.admin, 'Please share the transaction reference.']);
      const reply = (await inbox(db, p.student.user_id))[0]!;
      expect(reply).toMatchObject({ title: `New reply on grievance #${id}`, link: `/student/grievances/${id}` });
      expect(reply.body).toBe('The academic office wrote: Please share the transaction reference.');
      expect((await inbox(db, p.fac.user_id))[0]!.title).toBe(`New reply on grievance #${id}`);
      expect((await inbox(db, p.admin)).length).toBe(adminBefore);

      // the student replies -> admin and assignee, not the student
      const studentBefore = (await inbox(db, p.student.user_id)).length;
      await db.query('INSERT INTO grievance_comment (grievance_id, author_id, body) VALUES ($1, $2, $3)',
        [id, p.student.user_id, 'The reference is UTR 1234.']);
      expect((await inbox(db, p.admin))[0]!.title).toBe(`New reply on grievance #${id}`);
      expect((await inbox(db, p.student.user_id)).length).toBe(studentBefore);

      // closed -> raiser gets the outcome note
      await db.query(`CALL resolve_grievance($1, $2, 'Resolved', 'Payment matched; the ledger is corrected.')`, [id, p.admin]);
      expect((await inbox(db, p.student.user_id))[0]).toMatchObject({
        title: `Your grievance #${id} was resolved`, body: '"Payment shown as due": Payment matched; the ledger is corrected.',
      });

      // nobody else sees any of it
      expect(await inbox(db, p.other)).toEqual(expect.not.arrayContaining([expect.objectContaining({ title: expect.stringContaining(`#${id}`) })]));
    });
  });

  it('a personal notice reaches exactly one person', async () => {
    await inRollback(async (db) => {
      const p = await people(db);
      const n = await one<{ id: number }>(db, `SELECT notify_user($1, 'Just for you', 'Only this person receives it.', 'General') AS id`, [p.student.user_id]);
      const seen = await db.query('SELECT user_id FROM v_user_notices WHERE item_type = \'notification\' AND notification_id = $1', [n.id]);
      expect(seen.rows).toEqual([{ user_id: p.student.user_id }]);
    });
  });

  it('supports the assignment notify contract and preserves legacy personal read state', async () => {
    await inRollback(async (db) => {
      const p = await people(db);
      await db.query('CALL notify($1, $2, $3, $4)', [p.student.user_id, 'test', 'Contract message', '/student']);
      const current = await one<{ notification_id: number; is_read: boolean; link: string }>(db,
        `SELECT notification_id, is_read, link FROM v_user_notices
         WHERE user_id = $1 AND item_type = 'notification' AND notification_kind = 'test'`, [p.student.user_id]);
      expect(current).toMatchObject({ is_read: false, link: '/student' });
      await db.query('UPDATE notification SET read_at = now() WHERE notification_id = $1', [current.notification_id]);
      expect((await one<{ is_read: boolean }>(db,
        'SELECT is_read FROM v_user_notices WHERE user_id = $1 AND notification_id = $2', [p.student.user_id, current.notification_id])).is_read).toBe(true);

      const legacy = await one<{ notice_id: number }>(db,
        `SELECT post_notice(NULL, 'Legacy personal', 'A migrated personal notice.', 'General', $1::jsonb) AS notice_id`,
        [JSON.stringify([{ user_id: p.student.user_id }])]);
      await db.query('INSERT INTO notice_read (notice_id, user_id) VALUES ($1, $2)', [legacy.notice_id, p.student.user_id]);
      await db.query(`INSERT INTO notification
        (user_id, kind, title, text, category, legacy_notice_id, read_at)
        VALUES ($1, 'legacy', 'Legacy personal', 'A migrated personal notice.', 'General', $2, now())`,
        [p.student.user_id, legacy.notice_id]);
      const migrated = await one<{ notification_id: number; is_read: boolean }>(db,
        'SELECT notification_id, is_read FROM v_user_notices WHERE user_id = $1 AND title = $2', [p.student.user_id, 'Legacy personal']);
      expect(migrated.is_read).toBe(true);
      expect((await db.query('SELECT 1 FROM v_user_notices WHERE user_id = $1 AND notice_id = $2', [p.student.user_id, legacy.notice_id])).rows).toHaveLength(0);
    });
  });

  it('rejects invalid notify data and ignores inactive or unknown recipients', async () => {
    await inRollback(async (db) => {
      const p = await people(db);
      await db.query('SAVEPOINT invalid_link');
      await expect(db.query('CALL notify($1, $2, $3, $4)', [p.student.user_id, 'bad', 'External', 'https://example.com'])).rejects.toThrow(/internal portal/);
      await db.query('ROLLBACK TO SAVEPOINT invalid_link');
      await db.query('SAVEPOINT invalid_kind');
      await expect(db.query('CALL notify($1, $2, $3, $4)', [p.student.user_id, '', 'Message', null])).rejects.toThrow(/kind/);
      await db.query('ROLLBACK TO SAVEPOINT invalid_kind');
      await db.query('CALL notify($1, $2, $3, $4)', [999999999, 'test', 'Nobody receives this', null]);
      const inactive = await one<{ user_id: number }>(db, `SELECT user_id FROM app_user WHERE is_active ORDER BY user_id LIMIT 1`);
      await db.query('UPDATE app_user SET is_active = false WHERE user_id = $1', [inactive.user_id]);
      await db.query('CALL notify($1, $2, $3, $4)', [inactive.user_id, 'test', 'Inactive receives nothing', null]);
      expect((await db.query(`SELECT 1 FROM notification WHERE kind = 'test' AND text IN ('Nobody receives this', 'Inactive receives nothing')`)).rows).toHaveLength(0);
    });
  });

  it('faculty cannot address individual people', async () => {
    await inRollback(async (db) => {
      const p = await people(db);
      await expect(db.query(`SELECT post_notice($1, 'Private message', 'Faculty cannot target one student.', 'General', $2::jsonb)`,
        [p.fac.user_id, JSON.stringify([{ user_id: p.student.user_id }])])).rejects.toThrow(/divisions they teach/);
    });
  });

  it('attendance alert shows while a student is below the minimum and lists the courses', async () => {
    await inRollback(async (db) => {
      const short = await one<{ user_id: number; n: number; worst: string }>(db, `
        SELECT u.user_id, count(*)::int AS n, (array_agg(v.course_code ORDER BY v.attendance_pct))[1] AS worst
        FROM v_student_attendance_by_course v JOIN app_user u ON u.student_id = v.student_id
        WHERE v.academic_session_id = current_session_id() AND v.eligibility = 'Shortage' AND u.is_active
        GROUP BY u.user_id ORDER BY u.user_id LIMIT 1`);
      const alerts = (await db.query('SELECT * FROM user_alerts($1)', [short.user_id])).rows;
      const a = alerts.find((x) => x.kind === 'attendance');
      expect(a.title).toBe(`Attendance below the minimum in ${short.n} course${short.n === 1 ? '' : 's'}`);
      expect(a.body.startsWith(short.worst)).toBe(true);

      const fine = await one<{ user_id: number }>(db, `
        SELECT u.user_id FROM app_user u WHERE u.role = 'student' AND u.is_active AND NOT EXISTS (
          SELECT 1 FROM v_student_attendance_by_course v WHERE v.student_id = u.student_id
            AND v.academic_session_id = current_session_id() AND v.eligibility = 'Shortage') ORDER BY u.user_id LIMIT 1`);
      expect((await db.query(`SELECT * FROM user_alerts($1) WHERE kind = 'attendance'`, [fine.user_id])).rows).toHaveLength(0);
    });
  });

  it('stores one attendance-shortage notification on the eligible-to-shortage transition only', async () => {
    await inRollback(async (db) => {
      const before = await one<{
        user_id: number; student_id: number; course_id: number; academic_session_id: string;
        min_attendance_pct: number; course_code: string; course_name: string;
      }>(db, `
        SELECT u.user_id, a.student_id, a.course_id, a.academic_session_id,
               c.min_attendance_pct, c.course_code, c.course_name
        FROM attendance_summary a
        JOIN course c USING (course_id)
        JOIN app_user u ON u.student_id = a.student_id
        JOIN student s ON s.student_id = a.student_id
        WHERE a.academic_session_id = current_session_id()
          AND a.total_sessions > 0 AND a.attendance_pct >= c.min_attendance_pct
          AND c.min_attendance_pct > 0 AND u.role = 'student' AND u.is_active AND s.status = 'Active'
        ORDER BY u.user_id, a.course_id LIMIT 1`);
      const other = await one<{ user_id: number }>(db, `
        SELECT u.user_id FROM app_user u JOIN student s ON s.student_id = u.student_id
        WHERE u.role = 'student' AND u.is_active AND s.status = 'Active' AND u.user_id <> $1
        ORDER BY u.user_id LIMIT 1`, [before.user_id]);
      const count = (userId: number) => db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notification
         WHERE user_id = $1 AND kind = 'attendance_shortage' AND text LIKE $2`,
        [userId, `Attendance shortage: ${before.course_code}%`]).then((r) => r.rows[0]!.n);

      expect(await count(before.user_id)).toBe(0);
      expect(await count(other.user_id)).toBe(0);

      await db.query(`
        UPDATE attendance_summary
        SET total_sessions = 100, attended = GREATEST(0, $1 - 1), last_updated = now()
        WHERE student_id = $2 AND course_id = $3 AND academic_session_id = $4`,
      [before.min_attendance_pct, before.student_id, before.course_id, before.academic_session_id]);

      expect(await count(before.user_id)).toBe(1);
      expect(await count(other.user_id)).toBe(0);
      const notice = await one<{ text: string; category: string; link: string }>(db,
        `SELECT text, category, link FROM notification
         WHERE user_id = $1 AND kind = 'attendance_shortage' AND text LIKE $2`,
        [before.user_id, `Attendance shortage: ${before.course_code}%`]);
      expect(notice).toMatchObject({ category: 'Academic', link: '/student' });
      expect(notice.text).toContain(before.course_name);
      expect(notice.text).toContain(`${before.min_attendance_pct}%`);

      // A later refresh while still below the minimum must not create another event.
      await db.query(`
        UPDATE attendance_summary
        SET total_sessions = 101, attended = GREATEST(0, $1 - 1), last_updated = now()
        WHERE student_id = $2 AND course_id = $3 AND academic_session_id = $4`,
      [before.min_attendance_pct, before.student_id, before.course_id, before.academic_session_id]);
      expect(await count(before.user_id)).toBe(1);

      // The trigger ignores attendance summaries from historical academic sessions.
      const historical = await db.query<{
        user_id: number; student_id: number; course_id: number; academic_session_id: string;
        min_attendance_pct: number; course_code: string;
      }>(`
        SELECT u.user_id, a.student_id, a.course_id, a.academic_session_id,
               c.min_attendance_pct, c.course_code
        FROM attendance_summary a
        JOIN course c USING (course_id)
        JOIN app_user u ON u.student_id = a.student_id
        JOIN student s ON s.student_id = a.student_id
        WHERE a.academic_session_id <> current_session_id()
          AND a.total_sessions > 0 AND a.attendance_pct >= c.min_attendance_pct
          AND c.min_attendance_pct > 0 AND u.role = 'student'
          AND u.is_active AND s.status = 'Active'
        ORDER BY u.user_id, a.course_id LIMIT 1`);
      if (historical.rows[0]) {
        const h = historical.rows[0];
        const historicalCount = () => db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM notification
           WHERE user_id = $1 AND kind = 'attendance_shortage' AND text LIKE $2`,
          [h.user_id, `Attendance shortage: ${h.course_code}%`]).then((r) => r.rows[0]!.n);
        await db.query(`
          UPDATE attendance_summary
          SET total_sessions = 100, attended = GREATEST(0, $1 - 1), last_updated = now()
          WHERE student_id = $2 AND course_id = $3 AND academic_session_id = $4`,
        [h.min_attendance_pct, h.student_id, h.course_id, h.academic_session_id]);
        expect(await historicalCount()).toBe(0);
      }

      // An otherwise eligible student who is inactive must not receive the stored event.
      const inactive = await one<{
        user_id: number; student_id: number; course_id: number; academic_session_id: string;
        min_attendance_pct: number; course_code: string;
      }>(db, `
        SELECT u.user_id, a.student_id, a.course_id, a.academic_session_id,
               c.min_attendance_pct, c.course_code
        FROM attendance_summary a
        JOIN course c USING (course_id)
        JOIN app_user u ON u.student_id = a.student_id
        JOIN student s ON s.student_id = a.student_id
        WHERE a.academic_session_id = current_session_id()
          AND a.total_sessions > 0 AND a.attendance_pct >= c.min_attendance_pct
          AND c.min_attendance_pct > 0 AND u.role = 'student'
          AND u.is_active AND s.status = 'Active' AND u.user_id <> $1
        ORDER BY u.user_id, a.course_id LIMIT 1`, [before.user_id]);
      await db.query('UPDATE app_user SET is_active = false WHERE user_id = $1', [inactive.user_id]);
      await db.query(`
        UPDATE attendance_summary
        SET total_sessions = 100, attended = GREATEST(0, $1 - 1), last_updated = now()
        WHERE student_id = $2 AND course_id = $3 AND academic_session_id = $4`,
      [inactive.min_attendance_pct, inactive.student_id, inactive.course_id, inactive.academic_session_id]);
      expect((await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM notification
         WHERE user_id = $1 AND kind = 'attendance_shortage' AND text LIKE $2`,
        [inactive.user_id, `Attendance shortage: ${inactive.course_code}%`])).rows[0]!.n).toBe(0);
    });
  });

  it('fee alert switches on once T6 provides v_student_fee_status', async () => {
    await inRollback(async (db) => {
      const p = await people(db);
      const fees = () => db.query(`SELECT * FROM user_alerts($1) WHERE kind = 'fees'`, [p.student.user_id]).then((r) => r.rows);
      expect(await fees()).toHaveLength(0);                       // no fee data yet: no alert, no error

      await db.query(`CREATE VIEW v_student_fee_status AS
        SELECT $$${p.student.student_id}$$::int AS student_id, '2026-27'::text AS academic_year, 132000::numeric AS total_due,
               66000::numeric AS total_paid, 66000::numeric AS outstanding, (current_date - 10) AS next_due_date, false AS is_no_dues`);
      expect((await fees())[0]).toMatchObject({ severity: 'high', title: 'Fees overdue: Rs 66,000', link: '/student/fee' });

      await db.query(`CREATE OR REPLACE VIEW v_student_fee_status AS
        SELECT $$${p.student.student_id}$$::int AS student_id, '2026-27'::text AS academic_year, 132000::numeric AS total_due,
               132000::numeric AS total_paid, 0::numeric AS outstanding, NULL::date AS next_due_date, true AS is_no_dues`);
      expect(await fees()).toHaveLength(0);                       // paid up: the alert disappears
    });
  });

  it('exam timetable hook reaches the chosen students as an important exam notice', async () => {
    await inRollback(async (db) => {
      const d = await one<{ dept_id: string; year_of_study: number; user_id: number }>(db, `
        SELECT dv.dept_id, dv.year_of_study, u.user_id FROM student_section ss JOIN division dv USING (division_id)
        JOIN app_user u USING (student_id) WHERE ss.academic_session_id = current_session_id() AND u.is_active
        ORDER BY u.user_id LIMIT 1`);
      const n = await one<{ id: number }>(db,
        `SELECT post_exam_timetable_notice('End-semester timetable published', 'The timetable is on the exam page.', $1, $2::smallint) AS id`,
        [d.dept_id, d.year_of_study]);
      const row = await one<{ is_important: boolean; category: string; source: string }>(db,
        'SELECT is_important, category, source FROM v_user_notices WHERE user_id = $1 AND notice_id = $2', [d.user_id, n.id]);
      expect(row).toEqual({ is_important: true, category: 'Exam', source: 'exam' });
      const reach = await one<{ recipients: number }>(db, 'SELECT recipients FROM v_notice_reach WHERE notice_id = $1', [n.id]);
      const expected = await one<{ n: number }>(db, `
        SELECT count(*)::int AS n FROM v_user_audience WHERE role = 'student' AND dept_id = $1 AND year_of_study = $2`,
        [d.dept_id, d.year_of_study]);
      expect(reach.recipients).toBe(expected.n);
    });
  });

  it('results hook reaches only the chosen department and year', async () => {
    await inRollback(async (db) => {
      const audience = await one<{ dept_id: string; year_of_study: number }>(db, `
        SELECT dept_id, year_of_study
        FROM v_user_audience
        WHERE role = 'student' AND dept_id IS NOT NULL AND year_of_study IS NOT NULL
        GROUP BY dept_id, year_of_study
        ORDER BY dept_id, year_of_study LIMIT 1`);
      const outside = await one<{ user_id: number }>(db, `
        SELECT user_id FROM v_user_audience
        WHERE role = 'student'
          AND (dept_id IS DISTINCT FROM $1 OR year_of_study IS DISTINCT FROM $2)
        ORDER BY user_id LIMIT 1`, [audience.dept_id, audience.year_of_study]);
      const n = await one<{ id: number }>(db,
        `SELECT post_results_notice('Results published', 'Your semester results are now available.', $1, $2::smallint) AS id`,
        [audience.dept_id, audience.year_of_study]);

      const notice = await one<{
        is_important: boolean; category: string; source: string; expires_at: string;
      }>(db, 'SELECT is_important, category, source, expires_at FROM notice WHERE notice_id = $1', [n.id]);
      expect(notice).toMatchObject({ is_important: true, category: 'Exam', source: 'results' });
      expect((await db.query(`
        SELECT expires_at > now() + interval '29 days'
           AND expires_at <= now() + interval '30 days' AS within_results_window
        FROM notice WHERE notice_id = $1`, [n.id])).rows[0]!.within_results_window).toBe(true);

      const expected = (await db.query<{ user_id: number }>(`
        SELECT user_id FROM v_user_audience
        WHERE role = 'student' AND dept_id = $1 AND year_of_study = $2
        ORDER BY user_id`, [audience.dept_id, audience.year_of_study])).rows;
      const actual = (await db.query<{ user_id: number }>(`
        SELECT user_id FROM v_user_notices
        WHERE notice_id = $1 ORDER BY user_id`, [n.id])).rows;
      expect(actual).toEqual(expected);
      expect(actual.length).toBeGreaterThan(0);
      expect((await db.query('SELECT 1 FROM v_user_notices WHERE notice_id = $1 AND user_id = $2',
        [n.id, outside.user_id])).rows).toHaveLength(0);
    });
  });
});
