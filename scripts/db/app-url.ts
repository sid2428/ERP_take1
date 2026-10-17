/**
 * Derives the web app's connection string from the owner's Supabase URL: same pooler host,
 * but the least-privilege erp_app role and the transaction-mode port (6543, suited to
 * serverless functions). Checks that the role can sign in and sees the erp schema, then writes
 * APP_DATABASE_URL into the env file so it can be copied into Vercel.
 *
 * Usage: npm run supabase:app-url
 */
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

const ENV_FILE = '.env.supabase';

async function main(): Promise<void> {
  const owner = process.env.DATABASE_URL;
  const password = process.env.APP_DB_PASSWORD;
  if (!owner || !password) throw new Error(`DATABASE_URL and APP_DB_PASSWORD must be set in ${ENV_FILE}`);

  const url = new URL(owner);
  const projectRef = url.username.includes('.') ? url.username.split('.').slice(1).join('.') : '';
  url.username = projectRef ? `erp_app.${projectRef}` : 'erp_app';
  url.password = password;
  if (url.hostname.endsWith('pooler.supabase.com')) url.port = '6543';
  const appUrl = url.toString();

  const client = new pg.Client({ connectionString: appUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const { rows } = await client.query(`SELECT current_user AS role, current_setting('search_path') AS search_path,
      current_setting('TimeZone') AS timezone, (SELECT count(*)::int FROM student) AS students`);
  console.table(rows[0]);
  // the app role must not be able to change the schema
  const denied = await client.query('CREATE TABLE erp.should_not_exist (x int)').then(() => false, () => true);
  await client.end();
  if (!denied) throw new Error('erp_app was able to create a table: privileges are too broad');
  console.log('erp_app cannot create tables: OK');

  const env = await readFile(ENV_FILE, 'utf8');
  const line = `APP_DATABASE_URL=${appUrl}`;
  const next = /^APP_DATABASE_URL=.*$/m.test(env) ? env.replace(/^APP_DATABASE_URL=.*$/m, line) : `${env.trimEnd()}\n${line}\n`;
  await writeFile(ENV_FILE, next, 'utf8');
  console.log(`APP_DATABASE_URL written to ${ENV_FILE} (transaction pooler, erp_app role)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, '<connection-url>') : err);
  process.exit(1);
});
