import 'dotenv/config';
import pg from 'pg';

export const hasDatabase = Boolean(process.env.DATABASE_URL);

/** Run `fn` inside a transaction that is always rolled back, so tests never change data. */
export async function inRollback<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL search_path = erp, public');
    return await fn(db);
  } finally {
    await db.query('ROLLBACK').catch(() => undefined);
    await db.end();
  }
}

export async function one<T extends pg.QueryResultRow>(db: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await db.query<T>(sql, params);
  if (!rows[0]) throw new Error(`no row returned: ${sql}`);
  return rows[0];
}
