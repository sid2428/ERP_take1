import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { hasDatabase, inRollback, one } from './helpers.js';

/** A conducted session, a unit of its course, and a unit of some other course. */
async function fixture(db: pg.Client) {
  const s = await one<{ session_id: number; assignment_id: number; course_id: number; faculty_id: number }>(db,
    `SELECT s.session_id, s.assignment_id, ta.course_id, ta.faculty_id
       FROM attendance_session s JOIN teaching_assignment ta USING (assignment_id)
      WHERE s.session_status = 'Conducted' ORDER BY s.session_id LIMIT 1`);
  const other = await one<{ course_id: number }>(db,
    'SELECT course_id FROM course WHERE course_id <> $1 ORDER BY course_id LIMIT 1', [s.course_id]);
  await db.query('DELETE FROM course_unit WHERE course_id = ANY($1)', [[s.course_id, other.course_id]]);
  const unit = await one<{ unit_id: number }>(db,
    `INSERT INTO course_unit (course_id, unit_no, unit_title, planned_lectures) VALUES ($1, 1, 'Test unit', 2) RETURNING unit_id`,
    [s.course_id]);
  const otherUnit = await one<{ unit_id: number }>(db,
    `INSERT INTO course_unit (course_id, unit_no, unit_title, planned_lectures) VALUES ($1, 1, 'Other unit', 2) RETURNING unit_id`,
    [other.course_id]);
  return { ...s, unitId: unit.unit_id, otherUnitId: otherUnit.unit_id };
}

describe.skipIf(!hasDatabase)('T3-3 syllabus coverage', () => {
  it('limits units to numbers 1 to 5 and planned lectures above zero', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await expect(db.query(
        `INSERT INTO course_unit (course_id, unit_no, unit_title, planned_lectures) VALUES ($1, 6, 'Too far', 3)`,
        [f.course_id])).rejects.toThrow(/check constraint/);
    });
    await inRollback(async (db) => {
      const f = await fixture(db);
      await expect(db.query(
        `INSERT INTO course_unit (course_id, unit_no, unit_title, planned_lectures) VALUES ($1, 2, 'No lectures', 0)`,
        [f.course_id])).rejects.toThrow(/check constraint/);
    });
  });

  it('rejects a unit that belongs to a different course', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await expect(db.query('INSERT INTO syllabus_coverage (session_id, unit_id) VALUES ($1, $2)',
        [f.session_id, f.otherUnitId])).rejects.toThrow(/does not belong/);
    });
  });

  it('counts a tagged session in the progress views', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      await db.query('INSERT INTO syllabus_coverage (session_id, unit_id) VALUES ($1, $2)', [f.session_id, f.unitId]);
      const row = await one<{ planned_lectures: number; delivered: number; pct: string }>(db,
        'SELECT planned_lectures, delivered, pct FROM v_course_syllabus_progress WHERE assignment_id = $1 AND unit_id = $2',
        [f.assignment_id, f.unitId]);
      expect(row.planned_lectures).toBe(2);
      expect(row.delivered).toBe(1);
      expect(Number(row.pct)).toBe(50);
      const sum = await one<{ planned_total: number; delivered_total: number }>(db,
        'SELECT planned_total, delivered_total FROM v_assignment_syllabus_summary WHERE assignment_id = $1', [f.assignment_id]);
      expect(sum.planned_total).toBe(2);
      expect(sum.delivered_total).toBe(1);
    });
  });

  it('lets only the assigned faculty member tag a session', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const other = await one<{ faculty_id: number }>(db,
        `SELECT faculty_id FROM faculty WHERE faculty_id <> $1 AND status = 'Active' ORDER BY faculty_id LIMIT 1`, [f.faculty_id]);
      await expect(db.query('CALL tag_session_unit($1, $2, $3)', [f.session_id, f.unitId, other.faculty_id]))
        .rejects.toThrow(/did not take session/);
    });
    await inRollback(async (db) => {
      const f = await fixture(db);
      await db.query('CALL tag_session_unit($1, $2, $3)', [f.session_id, f.unitId, f.faculty_id]);
      const n = await one<{ n: string }>(db, 'SELECT count(*) AS n FROM syllabus_coverage WHERE session_id = $1', [f.session_id]);
      expect(Number(n.n)).toBe(1);
    });
  });

  it('does not allow tagging a cancelled session', async () => {
    await inRollback(async (db) => {
      const f = await fixture(db);
      const { rows } = await db.query<{ session_id: number }>(
        `SELECT session_id FROM attendance_session WHERE session_status = 'Cancelled' LIMIT 1`);
      if (!rows[0]) return;          // the data set has no cancelled session: nothing to check
      await expect(db.query('INSERT INTO syllabus_coverage (session_id, unit_id) VALUES ($1, $2)',
        [rows[0].session_id, f.unitId])).rejects.toThrow(/only a conducted session/);
    });
  });
});
