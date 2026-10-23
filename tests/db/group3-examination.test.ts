import { describe, expect, it } from 'vitest';
import { hasDatabase, inRollback, one } from './helpers.js';

async function fails(db: import('pg').Client, sql: string, params: unknown[] = []): Promise<string> {
  await db.query('SAVEPOINT expect_fail');
  try {
    await db.query(sql, params);
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT expect_fail');
    return (err as Error).message;
  }
  throw new Error(`expected to fail: ${sql}`);
}

describe.skipIf(!hasDatabase)('Group 3 examination database logic', () => {
  it('blocks registrations below 75 percent and accepts exactly 75 percent', async () => {
    await inRollback(async (db) => {
      const fixture = await one<{
        student_id: number;
        course_id: number;
        academic_session_id: string;
      }>(db, `
        SELECT student_id, course_id, academic_session_id
        FROM attendance_summary
        WHERE academic_session_id = current_session_id()
          AND total_sessions > 0
        ORDER BY student_id, course_id
        LIMIT 1`);
      const cycle = await one<{ exam_cycle_id: number }>(db, `
        INSERT INTO exam_cycle (
          academic_session_id, exam_type, start_date, end_date, status
        )
        VALUES ($1, 'EndSem', current_date, current_date + 1, 'Upcoming')
        RETURNING exam_cycle_id`, [fixture.academic_session_id]);

      await db.query(`
        UPDATE attendance_summary
        SET total_sessions = 100, attended = 74
        WHERE student_id = $1 AND course_id = $2 AND academic_session_id = $3`,
      [fixture.student_id, fixture.course_id, fixture.academic_session_id]);

      const blocked = await fails(db, `
        INSERT INTO exam_registration (student_id, course_id, exam_cycle_id, registration_status)
        VALUES ($1, $2, $3, 'Registered')`,
      [fixture.student_id, fixture.course_id, cycle.exam_cycle_id]);
      expect(blocked).toContain('attendance is below 75%');

      const registration = await one<{ registration_id: number }>(db, `
        INSERT INTO exam_registration (student_id, course_id, exam_cycle_id, registration_status)
        VALUES ($1, $2, $3, 'Blocked')
        RETURNING registration_id`,
      [fixture.student_id, fixture.course_id, cycle.exam_cycle_id]);
      const blockedUpdate = await fails(db, `
        UPDATE exam_registration SET registration_status = 'Registered'
        WHERE registration_id = $1`,
      [registration.registration_id]);
      expect(blockedUpdate).toContain('attendance is below 75%');

      await db.query(`
        UPDATE attendance_summary
        SET total_sessions = 100, attended = 75
        WHERE student_id = $1 AND course_id = $2 AND academic_session_id = $3`,
      [fixture.student_id, fixture.course_id, fixture.academic_session_id]);
      const accepted = await one<{ attendance_percentage: number }>(db, `
        UPDATE exam_registration SET registration_status = 'Registered'
        WHERE registration_id = $1
        RETURNING attendance_percentage`,
      [registration.registration_id]);
      expect(Number(accepted.attendance_percentage)).toBe(75);
    });
  });

  it('calculates CGPA from final-attempt course credits and grade points', async () => {
    await inRollback(async (db) => {
      const fixture = await one<{
        student_id: number;
        expected_cgpa: number;
        calculated_cgpa: number;
      }>(db, `
        SELECT student_id,
               round((sum(c.credits * r.grade_points) / NULLIF(sum(c.credits), 0))::numeric, 2)::numeric(4,2)
                 AS expected_cgpa,
               calculate_cgpa(student_id) AS calculated_cgpa
        FROM course_result r
        JOIN course c USING (course_id)
        WHERE is_final_attempt
        GROUP BY student_id
        HAVING sum(c.credits) > 0
        ORDER BY student_id
        LIMIT 1`);

      expect(fixture.calculated_cgpa).toBe(fixture.expected_cgpa);
    });
  });

  it('exposes both division-defaulter and CGPA-rank analytical views', async () => {
    await inRollback(async (db) => {
      const defaulters = await db.query(`
        SELECT division_id, division_code, student_count, defaulter_count, defaulter_percentage
        FROM v_attendance_defaulters_by_division
        ORDER BY division_code
        LIMIT 1`);
      const ranks = await db.query(`
        SELECT student_id, student_number, student_name, cgpa, cgpa_rank
        FROM v_student_cgpa_rank
        ORDER BY cgpa_rank, student_number
        LIMIT 1`);
      expect(defaulters.rows).toEqual(expect.any(Array));
      expect(ranks.rows).toEqual(expect.any(Array));
      if (defaulters.rows[0]) {
        expect(defaulters.rows[0].defaulter_count).toBeGreaterThan(0);
      }
      if (ranks.rows[0]) {
        expect(Number(ranks.rows[0].cgpa_rank)).toBeGreaterThan(0);
      }
    });
  });
});
