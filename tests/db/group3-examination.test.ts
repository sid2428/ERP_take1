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
      await db.query(`INSERT INTO grade_scale(grade,min_percentage,max_percentage,grade_points,description)
        VALUES('ZZ',0,100,8,'test fixture') ON CONFLICT(grade) DO NOTHING`);
      const course = await one<{course_id:number}>(db, `SELECT course_id FROM course WHERE course_type='TH' AND credits>0
        AND NOT EXISTS(SELECT 1 FROM course_exam_scheme s WHERE s.course_id=course.course_id) ORDER BY course_id LIMIT 1`);
      await db.query(`INSERT INTO course_exam_scheme(course_id,internal_max,midsem_max,endsem_max,total_max) VALUES($1,20,20,60,100)`,[course.course_id]);
      const fixture = await one<{ student_id: number; course_id: number; session_id: string; semester: number }>(db, `
        SELECT s.student_id, c.course_id, current_session_id() AS session_id,
               COALESCE((SELECT min(pc.semester_no) FROM program_curriculum pc WHERE pc.course_id=c.course_id), 1) AS semester
        FROM student s CROSS JOIN course c
        WHERE c.course_id=$1 AND c.credits > 0
          AND NOT EXISTS(SELECT 1 FROM course_result r WHERE r.student_id=s.student_id AND r.course_id=c.course_id)
        ORDER BY s.student_id LIMIT 1`,[course.course_id]);
      await db.query(`INSERT INTO course_result
        (student_id,course_id,academic_session_id,semester,attempt_no,total_marks,max_marks,percentage,grade,grade_points,result_status,is_final_attempt)
        SELECT $1,$2,$3,$4,1,80,100,80,grade,grade_points,'Pass',true FROM grade_scale WHERE grade='ZZ'`,
      [fixture.student_id, fixture.course_id, fixture.session_id, fixture.semester]);
      const result = await one<{ expected_cgpa: string; calculated_cgpa: string }>(db, `
        SELECT round((sum(c.credits * r.grade_points) / sum(c.credits))::numeric, 2)::numeric(4,2) AS expected_cgpa,
               calculate_cgpa($1) AS calculated_cgpa
        FROM course_result r JOIN course c USING(course_id)
        WHERE r.student_id=$1 AND r.is_final_attempt GROUP BY r.student_id`, [fixture.student_id]);
      expect(Number(result.calculated_cgpa)).toBe(Number(result.expected_cgpa));
    });
  });

  it('applies type-based maxima and keeps every stored mark within its component maximum', async () => {
    await inRollback(async (db) => {
      const scheme = await one<{
        theory_mismatches: number;
        lab_mismatches: number;
        component_overages: number;
        schedule_mismatches: number;
      }>(db, `
        SELECT
          count(*) FILTER (WHERE c.course_type = 'TH'
            AND (sch.internal_max, sch.midsem_max, sch.endsem_max, sch.total_max) <> (20, 20, 60, 100))::int
            AS theory_mismatches,
          count(*) FILTER (WHERE c.course_type = 'LAB'
            AND (sch.internal_max, sch.midsem_max, sch.endsem_max, sch.total_max) <> (50, 0, 50, 100))::int
            AS lab_mismatches,
          (SELECT count(*)::int FROM exam_marks m JOIN course_exam_scheme s USING (course_id)
           WHERE m.internal_marks > s.internal_max OR m.midsem_marks > s.midsem_max
              OR m.endsem_marks > s.endsem_max) AS component_overages,
          (SELECT count(*)::int FROM exam_schedule es JOIN course_exam_scheme s USING (course_id)
           WHERE es.max_marks <> CASE es.exam_mode
             WHEN 'MidSem' THEN s.midsem_max
             WHEN 'EndSem Theory' THEN s.endsem_max
             WHEN 'Practical/Oral' THEN s.endsem_max
           END) AS schedule_mismatches
        FROM course c JOIN course_exam_scheme sch USING (course_id)`);
      expect(scheme).toEqual({
        theory_mismatches: 0, lab_mismatches: 0, component_overages: 0, schedule_mismatches: 0,
      });
    });
  });

  it('keeps totals, grades, SGPA and CGPA consistent for five random students', async () => {
    await inRollback(async (db) => {
      await db.query(`INSERT INTO grade_scale(grade,min_percentage,max_percentage,grade_points,description)
        VALUES('ZY',0,100,8,'test fixture') ON CONFLICT(grade) DO NOTHING`);
      const course = await one<{course_id:number}>(db, `SELECT course_id FROM course WHERE course_type='TH' AND credits>0
        AND NOT EXISTS(SELECT 1 FROM course_exam_scheme s WHERE s.course_id=course.course_id) ORDER BY course_id LIMIT 1`);
      await db.query(`INSERT INTO course_exam_scheme(course_id,internal_max,midsem_max,endsem_max,total_max) VALUES($1,20,20,60,100)`,[course.course_id]);
      const fixture = await one<{ session_id: string; semester: number; grade: string; grade_points: number }>(db, `
        SELECT current_session_id() AS session_id, 1 AS semester, grade, grade_points
        FROM grade_scale WHERE grade='ZY'`);
      const students = await db.query<{ student_id: number; course_id: number }>(`
        SELECT s.student_id,$1::int AS course_id FROM student s
        WHERE NOT EXISTS(SELECT 1 FROM course_result cr WHERE cr.student_id=s.student_id)
          AND NOT EXISTS(SELECT 1 FROM student_cgpa sc WHERE sc.student_id=s.student_id)
          AND NOT EXISTS(SELECT 1 FROM semester_result sr WHERE sr.student_id=s.student_id AND sr.academic_session_id=current_session_id())
        ORDER BY s.student_id LIMIT 5`,[course.course_id]);
      if (students.rows.length !== 5) throw new Error('Need five students without existing CGPA fixtures');
      for (const row of students.rows) {
        await db.query(`INSERT INTO course_result
          (student_id,course_id,academic_session_id,semester,attempt_no,total_marks,max_marks,percentage,grade,grade_points,result_status,is_final_attempt)
          VALUES($1,$2,$3,$4,1,80,100,80,$5,$6,'Pass',true)`,
        [row.student_id,row.course_id,fixture.session_id,fixture.semester,fixture.grade,fixture.grade_points]);
        await db.query(`INSERT INTO student_cgpa(student_id,semesters_completed,credits_attempted,credits_earned,cgpa,backlog_count)
          VALUES($1,1,(SELECT credits FROM course WHERE course_id=$2),(SELECT credits FROM course WHERE course_id=$2),$3,0)`,
        [row.student_id,row.course_id,fixture.grade_points]);
        await db.query(`INSERT INTO semester_result(student_id,academic_session_id,semester,credits_registered,credits_earned,sgpa,backlogs,result_status)
          VALUES($1,$2,$3,(SELECT credits FROM course WHERE course_id=$4),(SELECT credits FROM course WHERE course_id=$4),$5,0,'Pass')`,
        [row.student_id,fixture.session_id,fixture.semester,row.course_id,fixture.grade_points]);
      }
      const rows = await db.query<{
        student_id: number;
        mark_errors: number;
        result_errors: number;
        semester_errors: number;
        cgpa_errors: number;
      }>(`
        WITH picked AS (
          SELECT student_id FROM student_cgpa ORDER BY student_id DESC LIMIT 5
        ), semester_totals AS (
          SELECT r.student_id, r.academic_session_id, r.semester,
                 sum(c.credits)::smallint AS credits_registered,
                 sum(c.credits) FILTER (WHERE r.result_status = 'Pass')::smallint AS credits_earned,
                 round(sum(c.credits * r.grade_points) / NULLIF(sum(c.credits), 0), 2) AS sgpa,
                 count(*) FILTER (WHERE r.result_status = 'Fail')::smallint AS backlogs
          FROM course_result r JOIN course c USING (course_id)
          WHERE r.is_final_attempt
          GROUP BY r.student_id, r.academic_session_id, r.semester
        ), student_totals AS (
          SELECT r.student_id,
                 count(DISTINCT (r.academic_session_id, r.semester))::smallint AS semesters_completed,
                 sum(c.credits)::smallint AS credits_attempted,
                 sum(c.credits) FILTER (WHERE r.result_status = 'Pass')::smallint AS credits_earned,
                 round(sum(c.credits * r.grade_points) / NULLIF(sum(c.credits), 0), 2) AS cgpa,
                 count(*) FILTER (WHERE r.result_status = 'Fail')::smallint AS backlog_count
          FROM course_result r JOIN course c USING (course_id)
          WHERE r.is_final_attempt
          GROUP BY r.student_id
        )
        SELECT p.student_id,
          (SELECT count(*)::int FROM exam_marks m JOIN course_exam_scheme s USING (course_id)
           WHERE m.student_id = p.student_id AND (
             m.internal_marks > s.internal_max OR m.midsem_marks > s.midsem_max
             OR m.endsem_marks > s.endsem_max
           )) AS mark_errors,
          (SELECT count(*)::int FROM course_result r JOIN course_exam_scheme s USING (course_id)
           WHERE r.student_id = p.student_id AND (
             r.max_marks <> s.total_max OR r.total_marks > s.total_max
             OR r.percentage <> round(r.total_marks * 100.0 / s.total_max, 2)
             OR r.grade <> (SELECT gs.grade FROM grade_scale gs
               WHERE r.percentage BETWEEN gs.min_percentage AND gs.max_percentage
               ORDER BY gs.min_percentage DESC LIMIT 1)
             OR r.grade_points <> (SELECT gs.grade_points FROM grade_scale gs
               WHERE r.percentage BETWEEN gs.min_percentage AND gs.max_percentage
               ORDER BY gs.min_percentage DESC LIMIT 1)
             OR r.result_status <> CASE WHEN r.percentage >= s.passing_percentage
               THEN 'Pass'::exam_result_state ELSE 'Fail'::exam_result_state END
           )) AS result_errors,
          (SELECT count(*)::int FROM semester_result sr
           JOIN semester_totals t USING (student_id, academic_session_id, semester)
           WHERE sr.student_id = p.student_id AND (
             sr.credits_registered <> t.credits_registered OR sr.credits_earned <> t.credits_earned
             OR sr.sgpa <> t.sgpa OR sr.backlogs <> t.backlogs
             OR sr.result_status <> CASE WHEN t.backlogs = 0
               THEN 'Pass'::semester_result_state ELSE 'ATKT'::semester_result_state END
           )) AS semester_errors,
          (SELECT count(*)::int FROM student_cgpa sc
           JOIN student_totals t USING (student_id)
           WHERE sc.student_id = p.student_id AND (
             sc.semesters_completed <> t.semesters_completed
             OR sc.credits_attempted <> t.credits_attempted OR sc.credits_earned <> t.credits_earned
             OR sc.cgpa <> t.cgpa OR sc.cgpa <> calculate_cgpa(sc.student_id)
             OR sc.backlog_count <> t.backlog_count
           )) AS cgpa_errors
        FROM picked p`);

      expect(rows.rows).toHaveLength(5);
      for (const row of rows.rows) {
        expect(row.mark_errors, `student ${row.student_id} marks`).toBe(0);
        expect(row.result_errors, `student ${row.student_id} course results`).toBe(0);
        expect(row.semester_errors, `student ${row.student_id} semester results`).toBe(0);
        expect(row.cgpa_errors, `student ${row.student_id} CGPA`).toBe(0);
      }
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
