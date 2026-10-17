/**
 * Sets the login password of the least-privilege `erp_app` role from APP_DB_PASSWORD.
 *
 * Usage: npm run db:app-password        (local)
 *        npm run supabase:app-password  (Supabase; APP_DB_PASSWORD in .env.supabase)
 */
import { withClient } from './client.js';

async function main(): Promise<void> {
  const password = process.env.APP_DB_PASSWORD;
  if (!password || password.length < 16) {
    throw new Error('set APP_DB_PASSWORD (at least 16 characters) in the env file first');
  }
  await withClient(async (db) => {
    await db.query(`ALTER ROLE erp_app WITH LOGIN PASSWORD ${db.escapeLiteral(password)}`);
  });
  console.log('erp_app password updated');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
