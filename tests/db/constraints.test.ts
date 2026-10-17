/**
 * Database-level rules from the group modules, exercised against the loaded database.
 * Every test runs in a rolled-back transaction.
 */
import { describe, expect, it } from 'vitest';
import { hasDatabase, inRollback, one } from './helpers.js';

describe.skipIf(!hasDatabase)('academic structure (G2 rules)', () => {
  it('rejects a prerequisite that would create a cycle', async () => {
    await inRollback(async (db) => {
      // 4 (CSE211) requires 1 (CSE111) in the G2 data; the reverse edge closes a loop.
      await expect(db.query('INSERT INTO course_prerequisite (course_id, prereq_course_id) VALUES (1, 4)'))
        .rejects.toThrow(/prerequisite cycle detected/);
    });
  });

  it('allows only one current academic session', async () => {
    await inRollback(async (db) => {
      await expect(db.query(`UPDATE academic_session SET is_current = true WHERE session_id = '2025-EVEN'`))
        .rejects.toThrow(/academic_session_one_current/);
    });
  });

  it('switches the current session atomically with set_current_session()', async () => {
    await inRollback(async (db) => {
      await db.query(`CALL set_current_session('2026-EVEN')`);
      const r = await one<{ id: string }>(db, 'SELECT current_session_id() AS id');
      expect(r.id).toBe('2026-EVEN');
    });
  });

  it('rejects a curriculum placement beyond the program length', async () => {
    await inRollback(async (db) => {
      await expect(db.query(`INSERT INTO program_curriculum (program_id, course_id, semester_no, course_category)
                             VALUES ('MTECH-CSE', 1, 6, 'CORE')`))
        .rejects.toThrow(/beyond the last semester/);
    });
  });
});

describe.skipIf(!hasDatabase)('sections, seats and teaching (G2 + G3 rules)', () => {
  it('rejects enrollment once an offering is full and updates its status', async () => {
    await inRollback(async (db) => {
      const o = await one<{ offering_id: number; course_id: number }>(db,
        `UPDATE course_offering SET max_seats = enrolled_count + 1
         WHERE offering_id = (SELECT min(offering_id) FROM course_offering) RETURNING offering_id, course_id`);
      const s = await db.query<{ student_id: number }>(`SELECT student_id FROM student WHERE status = 'Active'
        AND student_id NOT IN (SELECT student_id FROM student_enrollment WHERE course_id = $1) LIMIT 2`, [o.course_id]);
      const [first, second] = s.rows;
      const enroll = 'INSERT INTO student_enrollment (student_id, course_id, academic_session_id, offering_id) VALUES ($1, $2, current_session_id(), $3)';
      await db.query(enroll, [first?.student_id, o.course_id, o.offering_id]);
      const after = await one<{ status: string }>(db, 'SELECT status FROM course_offering WHERE offering_id = $1', [o.offering_id]);
      expect(after.status).toBe('FULL');
      await expect(db.query(enroll, [second?.student_id, o.course_id, o.offering_id])).rejects.toThrow(/already FULL/);
    });
  });

  it('rejects a batch that belongs to a different division', async () => {
    await inRollback(async (db) => {
      await expect(db.query(`UPDATE student_section SET batch_id = (SELECT batch_id FROM batch WHERE division_id <> student_section.division_id LIMIT 1)
                             WHERE student_id = (SELECT min(student_id) FROM student_section)`))
        .rejects.toThrow(/foreign key/);
    });
  });

  it('refuses to assign an inactive faculty member', async () => {
    await inRollback(async (db) => {
      const a = await one<{ assignment_id: number; faculty_id: number }>(db, 'SELECT assignment_id, faculty_id FROM teaching_assignment LIMIT 1');
      await db.query(`UPDATE faculty SET status = 'Inactive' WHERE faculty_id = (
                        SELECT faculty_id FROM faculty WHERE faculty_id <> $1 AND dept_id = (SELECT dept_id FROM faculty WHERE faculty_id = $1) LIMIT 1)
                      RETURNING faculty_id`, [a.faculty_id]);
      await expect(db.query(`UPDATE teaching_assignment SET faculty_id = (SELECT faculty_id FROM faculty WHERE status = 'Inactive' LIMIT 1)
                             WHERE assignment_id = $1`, [a.assignment_id]))
        .rejects.toThrow(/not active/);
    });
  });
});

describe.skipIf(!hasDatabase)('timetable clash rules (exclusion constraints)', () => {
  it('rejects a second booking of the same room in an overlapping period', async () => {
    await inRollback(async (db) => {
      const e = await one<{ room_id: number; day_of_week: number; start_period: number }>(db,
        `SELECT room_id, day_of_week, start_period FROM timetable_entry WHERE periods = 1 LIMIT 1`);
      // a different lecture assignment, moved into the occupied room and slot
      const other = await one<{ entry_id: number }>(db,
        `SELECT entry_id FROM timetable_entry WHERE room_id <> $1 AND periods = 1 LIMIT 1`, [e.room_id]);
      await expect(db.query(`UPDATE timetable_entry SET room_id = $1, day_of_week = $2, start_period = $3 WHERE entry_id = $4`,
        [e.room_id, e.day_of_week, e.start_period, other.entry_id])).rejects.toThrow(/no_room_clash|no_faculty_clash|no_division_clash/);
    });
  });

  it('rejects reassigning a lecture to a faculty member who is busy at that time', async () => {
    await inRollback(async (db) => {
      const pair = await one<{ busy_faculty: number; assignment_id: number }>(db, `
        SELECT b.faculty_id AS busy_faculty, a.assignment_id
        FROM timetable_entry a JOIN timetable_entry b
          ON a.day_of_week = b.day_of_week AND a.period_range && b.period_range AND a.faculty_id <> b.faculty_id
        JOIN faculty fa ON fa.faculty_id = a.faculty_id JOIN faculty fb ON fb.faculty_id = b.faculty_id AND fb.dept_id = fa.dept_id
        LIMIT 1`);
      await expect(db.query('UPDATE teaching_assignment SET faculty_id = $1 WHERE assignment_id = $2',
        [pair.busy_faculty, pair.assignment_id])).rejects.toThrow(/no_faculty_clash/);
    });
  });

  it('lets two batches of one division have labs at the same time, but not a lecture', async () => {
    await inRollback(async (db) => {
      const lab = await one<{ division_id: number; day_of_week: number; start_period: number }>(db,
        `SELECT division_id, day_of_week, start_period FROM timetable_entry WHERE batch_no IS NOT NULL LIMIT 1`);
      const lecture = await one<{ entry_id: number }>(db,
        `SELECT entry_id FROM timetable_entry WHERE division_id = $1 AND batch_no IS NULL LIMIT 1`, [lab.division_id]);
      await expect(db.query('UPDATE timetable_entry SET day_of_week = $1, start_period = $2 WHERE entry_id = $3',
        [lab.day_of_week, lab.start_period, lecture.entry_id])).rejects.toThrow(/no_division_clash|no_room_clash|no_faculty_clash/);
    });
  });
});

describe.skipIf(!hasDatabase)('attendance (G3 rules, compact storage)', () => {
  it('keeps the student summary in sync when a session is added', async () => {
    await inRollback(async (db) => {
      const a = await one<{ assignment_id: number; faculty_id: number; student_id: number }>(db, `
        SELECT ta.assignment_id, ta.faculty_id, r.student_id
        FROM teaching_assignment ta JOIN v_assignment_roster r USING (assignment_id)
        WHERE ta.session_type = 'Lecture' LIMIT 1`);
      const before = await one<{ total_sessions: number; attended: number }>(db,
        'SELECT total_sessions, attended FROM attendance_summary WHERE student_id = $1 AND assignment_id = $2',
        [a.student_id, a.assignment_id]);
      await db.query(`INSERT INTO attendance_session (assignment_id, session_date, session_number, duration_hrs,
                        absent_student_ids, marked_by, marked_at)
                      VALUES ($1, '2026-11-02', 999, 1.0, ARRAY[$2::int], $3, now())`,
        [a.assignment_id, a.student_id, a.faculty_id]);
      const after = await one<{ total_sessions: number; attended: number }>(db,
        'SELECT total_sessions, attended FROM attendance_summary WHERE student_id = $1 AND assignment_id = $2',
        [a.student_id, a.assignment_id]);
      expect(after.total_sessions).toBe(before.total_sessions + 1);
      expect(after.attended).toBe(before.attended);          // marked absent
    });
  });

  it('rejects an absentee who is not on the roster', async () => {
    await inRollback(async (db) => {
      const s = await one<{ session_id: number; assignment_id: number }>(db,
        `SELECT session_id, assignment_id FROM attendance_session WHERE session_status = 'Conducted' LIMIT 1`);
      const outsider = await one<{ student_id: number }>(db,
        `SELECT student_id FROM student WHERE status = 'Graduated' LIMIT 1`);
      await expect(db.query('UPDATE attendance_session SET absent_student_ids = absent_student_ids || $1::int WHERE session_id = $2',
        [outsider.student_id, s.session_id])).rejects.toThrow(/not on the roster/);
    });
  });

  it('rejects a session dated outside the term', async () => {
    await inRollback(async (db) => {
      const s = await one<{ session_id: number }>(db, 'SELECT session_id FROM attendance_session LIMIT 1');
      await expect(db.query(`UPDATE attendance_session SET session_date = '2027-02-01' WHERE session_id = $1`, [s.session_id]))
        .rejects.toThrow(/outside term/);
    });
  });

  it('exposes the same attendance through the normalized view', async () => {
    await inRollback(async (db) => {
      const s = await one<{ session_id: number; absent: number; roster: number }>(db, `
        SELECT s.session_id, cardinality(s.absent_student_ids) AS absent,
               (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = s.assignment_id) AS roster
        FROM attendance_session s WHERE session_status = 'Conducted' LIMIT 1`);
      const v = await one<{ a: number; p: number }>(db, `
        SELECT count(*) FILTER (WHERE status = 'A')::int AS a, count(*) FILTER (WHERE status = 'P')::int AS p
        FROM v_attendance_record WHERE session_id = $1`, [s.session_id]);
      expect(v.a).toBe(s.absent);
      expect(v.a + v.p).toBe(s.roster);
    });
  });
});
