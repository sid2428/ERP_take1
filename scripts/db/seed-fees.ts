/**
 * Loads the fee CSV into fee_record, wallet and wallet_txn (same job as seed-fee-data.sql,
 * but it needs only Node, not psql).
 *
 *   npm run db:seed-fees
 *   npm run db:seed-fees -- path/to/combined_student_fee_50000_wallet_v2.csv
 *
 * Uses the OWNER connection (DATABASE_URL in .env). Run migration 042 first.
 * Safe to run twice: rows that already exist are skipped. Everything runs in ONE transaction and
 * rolls back if any check at the end fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const CSV_NAME = 'combined_student_fee_50000_wallet_v2.csv';
const BATCH = 2000;

/** Minimal .env reader so this script works on its own (does not override real environment variables). */
function loadEnv(): void {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function findCsv(): string {
  const candidates = [
    process.argv[2],
    path.join(process.cwd(), 'scripts', CSV_NAME),
    path.join(process.cwd(), CSV_NAME),
    path.join(process.cwd(), 'data', CSV_NAME),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Could not find ${CSV_NAME}. Put it in the scripts folder, or pass its path after "--".`);
  return found;
}

/** CSV parser that understands quoted fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main(): Promise<void> {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL (the owner connection) is not set in .env.');
  }
  const csvPath = findCsv();
  console.log('Reading', csvPath);
  const [header, ...data] = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`The CSV has no "${name}" column. Use the _v2 file.`);
    return i;
  };
  const idx = {
    student: col('Student No'), tuition: col('Tuition Fee'), development: col('Development Fee'),
    examination: col('Examination Fee'), other: col('Other Fee'), late: col('Late Fee'),
    paid: col('Total Amount Paid'), outstanding: col('Outstanding Balance'), year: col('Academic Year'),
    wallet: col('Wallet amount'), recordId: col('Fee Record ID'), status: col('Fee Status'),
    outstandingPaise: col('Outstanding Paise'),
  };
  console.log(`CSV rows: ${data.length}`);

  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path = erp, public');

    await client.query(`
      CREATE TEMP TABLE fee_stage (
        student_number text, tuition numeric, development numeric, examination numeric, other numeric,
        late numeric, paid numeric, outstanding numeric, academic_year text, wallet numeric,
        fee_record_id text, fee_status text, outstanding_paise bigint
      ) ON COMMIT DROP`);

    for (let start = 0; start < data.length; start += BATCH) {
      const part = data.slice(start, start + BATCH);
      const pick = (i: number) => part.map((r) => r[i]);
      await client.query(
        `INSERT INTO fee_stage SELECT * FROM unnest(
           $1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[],
           $7::numeric[], $8::numeric[], $9::text[], $10::numeric[], $11::text[], $12::text[], $13::bigint[])`,
        [pick(idx.student), pick(idx.tuition), pick(idx.development), pick(idx.examination), pick(idx.other),
         pick(idx.late), pick(idx.paid), pick(idx.outstanding), pick(idx.year), pick(idx.wallet),
         pick(idx.recordId), pick(idx.status), pick(idx.outstandingPaise)]);
      console.log(`  staged ${Math.min(start + BATCH, data.length)} / ${data.length}`);
    }

    const missing = await client.query(
      `SELECT count(*)::int AS n FROM fee_stage s LEFT JOIN student st ON st.student_number = s.student_number
        WHERE st.student_id IS NULL`);
    console.log(`Students in the CSV that are not in the portal (skipped): ${missing.rows[0].n}`);

    const fees = await client.query(
      `INSERT INTO fee_record (fee_record_id, student_id, academic_year, tuition_paise, development_paise,
                               examination_paise, other_paise, late_fee_paise, opening_paid_paise)
       SELECT s.fee_record_id, st.student_id, s.academic_year, round(s.tuition * 100), round(s.development * 100),
              round(s.examination * 100), round(s.other * 100), round(s.late * 100), round(s.paid * 100)
         FROM fee_stage s JOIN student st ON st.student_number = s.student_number
       ON CONFLICT (fee_record_id) DO NOTHING`);
    const wallets = await client.query(
      `INSERT INTO wallet (student_id, balance_paise)
       SELECT st.student_id, round(s.wallet * 100)
         FROM fee_stage s JOIN student st ON st.student_number = s.student_number
       ON CONFLICT (student_id) DO NOTHING`);
    const ledger = await client.query(
      `INSERT INTO wallet_txn (student_id, kind, amount_paise, balance_after_paise, description)
       SELECT st.student_id, 'OPENING', round(s.wallet * 100), round(s.wallet * 100), 'Opening balance (imported)'
         FROM fee_stage s JOIN student st ON st.student_number = s.student_number
        WHERE s.wallet > 0
       ON CONFLICT DO NOTHING`);
    console.log(`New fee records: ${fees.rowCount}, new wallets: ${wallets.rowCount}, new ledger rows: ${ledger.rowCount}`);

    // Integrity checks: any mismatch aborts and rolls everything back.
    const checks = await client.query(`
      SELECT
        (SELECT count(*) FROM fee_stage s JOIN fee_record f ON f.fee_record_id = s.fee_record_id
          WHERE f.outstanding_paise <> s.outstanding_paise)::int AS bad_outstanding,
        (SELECT count(*) FROM fee_stage s JOIN fee_record f ON f.fee_record_id = s.fee_record_id
          WHERE f.fee_status::text <> s.fee_status)::int AS bad_status,
        (SELECT count(*) FROM wallet w
           LEFT JOIN (SELECT student_id, sum(amount_paise) AS total FROM wallet_txn GROUP BY student_id) t USING (student_id)
          WHERE w.balance_paise <> COALESCE(t.total, 0))::int AS bad_wallet`);
    const c = checks.rows[0] as { bad_outstanding: number; bad_status: number; bad_wallet: number };
    if (c.bad_outstanding || c.bad_status || c.bad_wallet) {
      throw new Error(`Integrity check failed (outstanding ${c.bad_outstanding}, status ${c.bad_status}, wallet ${c.bad_wallet}). Nothing was saved.`);
    }
    console.log('All integrity checks passed.');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }

  const summary = await client.query(
    `SELECT fee_status::text AS status, count(*)::int AS students, (sum(outstanding_paise) / 100)::bigint AS outstanding_rupees
       FROM erp.fee_record GROUP BY fee_status ORDER BY fee_status`);
  console.table(summary.rows);
  await client.end();
}

/** Connection failures arrive as an AggregateError with an empty message: unwrap them. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { code?: string; errors?: unknown[] };
  const parts = [e.message || e.name];
  if (e.code) parts.push(`(code ${e.code})`);
  for (const inner of e.errors ?? []) parts.push('\n  - ' + describe(inner));
  return parts.join(' ');
}

function hint(text: string): string {
  if (/ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT/.test(text)) {
    return 'The database could not be reached. If DATABASE_URL points at db.<project>.supabase.co (the direct connection), ' +
           'ask your lead for the "Session pooler" URI (port 5432) instead: the direct one often does not work from home networks (IPv6).';
  }
  if (/ENOTFOUND/.test(text)) return 'The database host name in DATABASE_URL was not found. Check it for typos.';
  if (/password authentication failed|28P01/.test(text)) return 'The database rejected the user name or password in DATABASE_URL.';
  if (/SSL|certificate/i.test(text)) return 'An SSL problem: check that DATABASE_SSL=true is in .env.';
  return '';
}

main().catch((err: unknown) => {
  const text = describe(err);
  console.error('\nFAILED:', text);
  const h = hint(text);
  if (h) console.error('\nHint:', h);
  process.exit(1);
});