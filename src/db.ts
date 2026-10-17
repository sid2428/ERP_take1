/**
 * PostgreSQL access for the web app. Connects as the least-privilege `erp_app` role, whose
 * search_path is `erp`, so SQL uses unqualified table names. Always parameterised ($1, $2 ...).
 */
import pg from 'pg';
import { config } from './config.js';

// numeric (credits, percentages) and bigint (counts) are small here: return JS numbers.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
// keep DATE as 'YYYY-MM-DD' text: converting to a JS Date would shift it by the timezone
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: config.isServerless ? 3 : 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('idle database client error', err);
});

export type Db = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow>(sql: string, params: unknown[] = [], db: Db = pool): Promise<T | undefined> {
  const result = await db.query<T>(sql, params);
  return result.rows[0];
}

/** Run `fn` in a transaction; rolls back on any error. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Translate a PostgreSQL constraint/trigger error into a message fit for the user, or null. */
export function friendlyDbError(err: unknown): string | null {
  if (!(err instanceof Error) || !('code' in err)) return null;
  const code = (err as { code?: string }).code;
  const detail = (err as { detail?: string }).detail;
  switch (code) {
    case '23514': return err.message.replace(/^new row .* violates check constraint/, 'Value not allowed:');  // check / trigger rules
    case '23505': return `That record already exists${detail ? ` (${detail})` : ''}.`;
    case '23503': return 'This change refers to a record that does not exist, or is still referenced elsewhere.';
    case '23P01': return 'This would clash with an existing booking.';
    case '23502': return 'A required value is missing.';
    case '22P02': case '22007': case '22008': return 'One of the values has the wrong format.';
    default: return null;
  }
}
