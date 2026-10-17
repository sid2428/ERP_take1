/**
 * Applies migrations/NNN-*.sql in order, each in its own transaction, and records them in
 * erp.schema_migrations. An already-applied file whose contents changed is reported as an error.
 *
 * Usage: npm run db:migrate
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withClient } from './client.js';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../migrations');

async function main(): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}-.+\.sql$/.test(f)).sort();

  await withClient(async (db) => {
    await db.query(`CREATE SCHEMA IF NOT EXISTS erp;
      CREATE TABLE IF NOT EXISTS erp.schema_migrations (
        name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map(
      (await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM erp.schema_migrations'))
        .rows.map((r) => [r.name, r.checksum]),
    );

    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      // hash with LF line endings so a Windows (CRLF) checkout matches what was applied
      const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`${file} was changed after being applied; add a new migration instead`);
        }
        continue;
      }
      process.stdout.write(`applying ${file} ... `);
      try {
        await db.query('BEGIN');
        await db.query(sql);
        await db.query('INSERT INTO erp.schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await db.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await db.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }
    console.log(`migrations up to date (${files.length} files)`);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
