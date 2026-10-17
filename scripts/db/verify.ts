/**
 * Integrity and size checks for a loaded database. Exits non-zero if any check fails.
 *
 * Usage: npm run db:verify
 */
import { withClient } from './client.js';

/** Each check returns the number of offending rows; 0 = pass. */
const CHECKS: { name: string; sql: string }[] = [
  {
    name: 'every active student has a section in the current term',
    sql: `SELECT count(*) FROM erp.student s WHERE s.status = 'Active' AND NOT EXISTS (
            SELECT 1 FROM erp.student_section ss WHERE ss.student_id = s.student_id
              AND ss.academic_session_id = erp.current_session_id())`,
  },
  {
    name: 'only active students have a current section',
    sql: `SELECT count(*) FROM erp.student_section ss JOIN erp.student s USING (student_id) WHERE s.status <> 'Active'`,
  },
  {
    name: 'current enrollments match the G2 curriculum (program + semester)',
    sql: `SELECT count(*) FROM erp.student_enrollment e
          JOIN erp.student s USING (student_id)
          JOIN erp.student_section ss ON ss.student_id = e.student_id AND ss.academic_session_id = e.academic_session_id
          JOIN erp.division d ON d.division_id = ss.division_id
          WHERE NOT EXISTS (SELECT 1 FROM erp.program_curriculum pc
                            WHERE pc.program_id = s.program_id AND pc.course_id = e.course_id
                              AND pc.semester_no = d.semester)`,
  },
  {
    name: 'every enrollment is covered by exactly one teaching assignment',
    sql: `SELECT count(*) FROM (
            SELECT e.student_id, e.course_id, count(r.assignment_id) AS n
            FROM erp.student_enrollment e
            LEFT JOIN erp.teaching_assignment ta ON ta.course_id = e.course_id AND ta.academic_session_id = e.academic_session_id
            LEFT JOIN erp.v_assignment_roster r ON r.assignment_id = ta.assignment_id AND r.student_id = e.student_id
            GROUP BY e.student_id, e.course_id) x WHERE n <> 1`,
  },
  {
    name: 'offering enrolled_count equals actual enrollments',
    sql: `SELECT count(*) FROM erp.course_offering o WHERE o.enrolled_count <> (
            SELECT count(*) FROM erp.student_enrollment e WHERE e.offering_id = o.offering_id AND e.status = 'Enrolled')`,
  },
  {
    name: 'every absentee is on the session roster',
    sql: `SELECT count(*) FROM erp.attendance_session s CROSS JOIN LATERAL unnest(s.absent_student_ids) AS a(student_id)
          WHERE NOT EXISTS (SELECT 1 FROM erp.v_assignment_roster r
                            WHERE r.assignment_id = s.assignment_id AND r.student_id = a.student_id)`,
  },
  {
    name: 'sessions fall on their timetable weekday',
    sql: `SELECT count(*) FROM erp.attendance_session s JOIN erp.timetable_entry te ON te.entry_id = s.timetable_entry_id
          WHERE extract(isodow FROM s.session_date) <> te.day_of_week`,
  },
  {
    name: 'summary matches a recount from the normalized view (sample of 300 students)',
    sql: `WITH sample AS (SELECT student_id FROM erp.student_section ORDER BY md5(student_id::text) LIMIT 300),
          recount AS (SELECT student_id, course_id, count(*) AS total, count(*) FILTER (WHERE status = 'P') AS present
                      FROM erp.v_attendance_record WHERE student_id IN (SELECT student_id FROM sample)
                      GROUP BY student_id, course_id)
          SELECT count(*) FROM erp.attendance_summary a JOIN sample USING (student_id)
          LEFT JOIN recount r USING (student_id, course_id)
          WHERE (a.total_sessions, a.attended) IS DISTINCT FROM (COALESCE(r.total, 0), COALESCE(r.present, 0))`,
  },
  {
    name: 'every department has an HOD from its own faculty',
    sql: `SELECT count(*) FROM erp.department d LEFT JOIN erp.faculty f ON f.faculty_id = d.hod_faculty_id
          WHERE f.dept_id IS DISTINCT FROM d.dept_id`,
  },
];

async function main(): Promise<void> {
  let failed = 0;
  await withClient(async (db) => {
    for (const check of CHECKS) {
      const { rows } = await db.query<{ count: string }>(check.sql);
      const bad = Number(rows[0]?.count ?? 0);
      if (bad > 0) failed++;
      console.log(`${bad === 0 ? 'PASS' : 'FAIL'}  ${check.name}${bad ? `  (${bad} rows)` : ''}`);
    }

    const sizes = await db.query<{ relname: string; rows: string; total: string; bytes: string }>(`
      SELECT c.relname, c.reltuples::bigint AS rows, pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
             pg_total_relation_size(c.oid) AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'erp' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC`);
    console.log('\nlargest tables (incl. indexes):');
    for (const r of sizes.rows.slice(0, 8)) {
      console.log(`  ${r.relname.padEnd(24)} ${r.rows.padStart(9)} rows  ${r.total}`);
    }
    const schemaBytes = sizes.rows.reduce((sum, r) => sum + Number(r.bytes), 0);
    const db_ = await db.query<{ size: string }>('SELECT pg_size_pretty(pg_database_size(current_database())) AS size');
    console.log(`erp schema total: ${(schemaBytes / 1024 ** 2).toFixed(1)} MB   whole database: ${db_.rows[0]?.size}   (Supabase free limit: 500 MB)`);
  });
  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
