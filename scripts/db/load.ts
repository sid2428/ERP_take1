/**
 * Bulk-loads data/generated/*.csv into the erp schema with COPY, in one transaction.
 * Re-runnable: every ERP data table is truncated first.
 *
 * Usage: npm run db:load        (after npm run data:build and npm run db:migrate)
 */
import { createReadStream, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { withClient } from './client.js';

const DATA_DIR = path.resolve(import.meta.dirname, '../../data/generated');

/** Load order follows the foreign keys. `bulk` tables skip their row triggers during the load
 *  (their trigger-maintained values are supplied by the generator and recomputed afterwards). */
const TABLES: { name: string; bulk?: boolean; optional?: boolean }[] = [
  { name: 'department' },
  { name: 'program' },
  { name: 'course' },
  { name: 'course_prerequisite' },
  { name: 'academic_session' },
  { name: 'program_curriculum' },
  { name: 'faculty' },
  { name: 'student' },
  { name: 'division' },
  { name: 'batch' },
  { name: 'student_section' },
  { name: 'room' },
  { name: 'time_slot' },
  { name: 'course_offering' },
  { name: 'student_enrollment', bulk: true },
  { name: 'teaching_assignment' },
  { name: 'timetable_entry' },
  { name: 'attendance_session', bulk: true },
  { name: 'app_user', optional: true },          // from npm run data:users
];

async function csvHeader(file: string): Promise<string[]> {
  const fh = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(4096), 0, 4096, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0] ?? '';
    return firstLine.trim().split(',');
  } finally {
    await fh.close();
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  await withClient(async (db) => {
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL statement_timeout = 0;
        SET LOCAL search_path = erp, public;
        SET LOCAL TIME ZONE 'Asia/Kolkata';          -- generated timestamps are college (IST) times
        SET CONSTRAINTS ALL DEFERRED`);
      const all = ['attendance_summary', 'attendance_correction', 'audit_log', 'user_session', ...TABLES.map((t) => t.name)];
      await db.query(`TRUNCATE ${all.map((t) => `erp.${t}`).join(', ')} RESTART IDENTITY CASCADE`);

      for (const { name, bulk, optional } of TABLES) {
        const file = path.join(DATA_DIR, `${name}.csv`);
        if (optional && !existsSync(file)) {
          console.log(`  ${name.padEnd(22)}   skipped (run npm run data:users to create accounts)`);
          continue;
        }
        const columns = await csvHeader(file);
        if (bulk) await db.query(`ALTER TABLE erp.${name} DISABLE TRIGGER USER`);
        const t0 = Date.now();
        const copy = db.query(copyFrom(
          `COPY erp.${name} (${columns.join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER true)`));
        await pipeline(createReadStream(file), copy);
        if (bulk) await db.query(`ALTER TABLE erp.${name} ENABLE TRIGGER USER`);
        console.log(`  ${name.padEnd(22)} ${String(copy.rowCount).padStart(9)} rows  ${Date.now() - t0} ms`);
      }

      // Identity columns were loaded with explicit ids: move each sequence past the max id.
      const ids = await db.query<{ table_name: string; column_name: string }>(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'erp' AND is_identity = 'YES'`);
      for (const { table_name, column_name } of ids.rows) {
        await db.query(`SELECT setval(pg_get_serial_sequence('erp.${table_name}', '${column_name}'),
                          GREATEST((SELECT max(${column_name}) FROM erp.${table_name}), 1))`);
      }

      const t0 = Date.now();
      const { rows } = await db.query<{ n: number }>('SELECT erp.refresh_attendance_summary() AS n');
      console.log(`  attendance_summary     ${String(rows[0]?.n).padStart(9)} rows  ${Date.now() - t0} ms (computed)`);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
    await db.query('ANALYZE');
  });
  console.log(`load complete in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
