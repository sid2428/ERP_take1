import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { hasDatabase, inRollback, one } from './helpers.js';

/** Builds a window (status Open) with two 1-seat/5-seat H1 offerings and three active students. */
async function fixture(db: pg.Client) {
  const { session_id } = await one<{ session_id: string }>(db, 'SELECT current_session_id() AS session_id');
  const students = (await db.query<{ student_id: number }>(
    `SELECT student_id FROM student WHERE status = 'Active' ORDER BY student_id LIMIT 3`)).rows.map((r) => r.student_id);
  const courses = (await db.query<{ course_id: number }>(
    `SELECT course_id FROM course c WHERE is_active AND NOT EXISTS
       (SELECT 1 FROM student_enrollment e WHERE e.course_id = c.course_id AND e.academic_session_id = $1)
     ORDER BY course_id LIMIT 2`, [session_id])).rows.map((r) => r.course_id);
  const a = await one<{ offering_id: number }>(db,
    `INSERT INTO course_offering (course_id, academic_session_id, section_name, max_seats)
     VALUES ($1, $2, 'TX', 1) RETURNING offering_id`, [courses[0], session_id]);
  const b = await one<{ offering_id: number }>(db,
    `INSERT INTO course_offering (course_id, academic_session_id, section_name, max_seats)
     VALUES ($1, $2, 'TX', 5) RETURNING offering_id`, [courses[1], session_id]);
  const w = await one<{ window_id: number }>(db,
    `INSERT INTO elective_window (academic_session_id, semester_no, elective_group, opens_at, closes_at, status)
     VALUES ($1, 6, 'H1', now() - interval '1 hour', now() + interval '1 day', 'Open') RETURNING window_id`,
    [session_id]);
  for (const off of [a.offering_id, b.offering_id]) {
    await db.query(`INSERT INTO elective_window_offering VALUES ($1, $2, $3)`, [w.window_id, off, session_id]);
  }
  return { students, windowId: w.window_id, offA: a.offering_id, offB: b.offering_id };
}

const pref = (db: pg.Client, w: number, s: number, o: number, rank: number) =>
  db.query(`INSERT INTO elective_preference (window_id, student_id, offering_id, preference_rank) VALUES ($1,$2,$3,$4)`,
    [w, s, o, rank]);

describe.skipIf(!hasDatabase)('T3-2 elective selection', () => {
  it('rejects choices when the window is outside its dates', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await db.query(`UPDATE elective_window SET opens_at = now() - interval '2 hours',
                      closes_at = now() - interval '1 hour' WHERE window_id = $1`, [f.windowId]);
      await expect(pref(db, f.windowId, f.students[0]!, f.offA, 1)).rejects.toThrow(/not open/);
    });
  });

  it('rejects choices when the window is closed by the admin', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await db.query(`UPDATE elective_window SET status = 'Closed' WHERE window_id = $1`, [f.windowId]);
      await expect(pref(db, f.windowId, f.students[0]!, f.offA, 1)).rejects.toThrow(/not open/);
    });
  });

  it('allows only one offering per rank', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await pref(db, f.windowId, f.students[0]!, f.offA, 1);
      await expect(pref(db, f.windowId, f.students[0]!, f.offB, 1)).rejects.toThrow(/unique|duplicate/i);
    });
  });

  it('never exceeds seats and falls back to the next choice', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      for (const s of f.students) {            // everyone ranks A (1 seat) first, B second
        await pref(db, f.windowId, s, f.offA, 1);
        await pref(db, f.windowId, s, f.offB, 2);
      }
      await db.query(`UPDATE elective_window SET status = 'Closed' WHERE window_id = $1`, [f.windowId]);
      await db.query('CALL allocate_electives($1)', [f.windowId]);

      const a = await one<{ enrolled_count: number; status: string }>(db,
        'SELECT enrolled_count, status FROM course_offering WHERE offering_id = $1', [f.offA]);
      const b = await one<{ enrolled_count: number }>(db,
        'SELECT enrolled_count FROM course_offering WHERE offering_id = $1', [f.offB]);
      expect(a.enrolled_count).toBe(1);
      expect(a.status).toBe('FULL');
      expect(b.enrolled_count).toBe(f.students.length - 1);

      const got = await db.query(
        'SELECT preference_rank FROM elective_allocation WHERE window_id = $1 ORDER BY merit_position', [f.windowId]);
      expect(got.rows.map((r) => r.preference_rank)).toEqual([1, 2, 2]);
    });
  });

  it('cannot allocate an open window or allocate twice', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await expect(db.query('CALL allocate_electives($1)', [f.windowId])).rejects.toThrow(/close window/);
    });
    await inRollback(async (db) => {
      const f = await fixture(db);
      await pref(db, f.windowId, f.students[0]!, f.offB, 1);
      await db.query(`UPDATE elective_window SET status = 'Closed' WHERE window_id = $1`, [f.windowId]);
      await db.query('CALL allocate_electives($1)', [f.windowId]);
      await expect(db.query('CALL allocate_electives($1)', [f.windowId])).rejects.toThrow(/already been allocated/);
    });
  });
});
