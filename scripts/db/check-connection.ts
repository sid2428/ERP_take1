/**
 * Read-only connection check: who we are, server version, and whether the ERP schema exists.
 *
 * Usage: npm run db:check   |   npm run supabase:check
 */
import { withClient } from './client.js';

async function main(): Promise<void> {
  await withClient(async (db) => {
    const { rows } = await db.query(`
      SELECT current_user AS "user", current_database() AS database,
             split_part(version(), ' on ', 1) AS server,
             pg_size_pretty(pg_database_size(current_database())) AS size,
             EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'erp') AS erp_schema,
             (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'erp') AS erp_tables,
             EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist') AS btree_gist_available,
             (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS can_create_roles`);
    console.table(rows[0]);
  });
}

main().catch((err: unknown) => {
  // never echo the connection string
  console.error(err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, '<connection-url>') : err);
  process.exit(1);
});
