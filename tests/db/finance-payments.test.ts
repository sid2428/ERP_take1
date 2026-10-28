import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { hasDatabase, inRollback, one } from './helpers.js';

type Purpose = 'FEE' | 'TOPUP';
let academicYearSequence = 0;

async function studentWithReceiptJoins(db: pg.Client): Promise<number> {
  const row = await one<{ student_id: number }>(db,
    `SELECT s.student_id FROM student s
       JOIN program p ON p.program_id = s.program_id
       JOIN department d ON d.dept_id = p.dept_id
       JOIN app_user u ON u.student_id = s.student_id AND u.role = 'student' AND u.is_active
      ORDER BY s.student_id LIMIT 1`);
  return row.student_id;
}

async function createPayment(
  db: pg.Client,
  studentId: number,
  purpose: Purpose,
  amountPaise: number,
  feeDuePaise = 0,
): Promise<{ paymentId: number; feeRecordId: string | null }> {
  let feeRecordId: string | null = null;
  if (purpose === 'FEE') {
    feeRecordId = `FT${randomBytes(11).toString('hex')}`;
    const academicYear = `2999-${String(academicYearSequence++).padStart(2, '0')}`;
    await db.query(
      `INSERT INTO fee_record
         (fee_record_id, student_id, academic_year, tuition_paise, development_paise,
          examination_paise, other_paise, late_fee_paise, opening_paid_paise)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0)`,
      [feeRecordId, studentId, academicYear, feeDuePaise]);
  }

  const gatewayOrderId = `order_test_${randomBytes(10).toString('hex')}`;
  const row = await one<{ payment_id: number }>(db,
    `INSERT INTO fee_payment (student_id, fee_record_id, purpose, gateway, gateway_order_id, amount_paise)
     VALUES ($1, $2, $3::payment_purpose, 'SIMULATED', $4, $5)
     RETURNING payment_id`,
    [studentId, feeRecordId, purpose, gatewayOrderId, amountPaise]);
  return { paymentId: row.payment_id, feeRecordId };
}

async function applyPayment(db: pg.Client, orderId: string, paymentId: string, method: string) {
  return one<{ payment_id: number; status: string; receipt_no: string; method: string }>(db,
    'SELECT payment_id, status::text AS status, receipt_no, method FROM apply_fee_payment($1, $2, $3)',
    [orderId, paymentId, method]);
}

async function createOrderReference(db: pg.Client, paymentId: number): Promise<string> {
  return one<{ gateway_order_id: string }>(db,
    'SELECT gateway_order_id FROM fee_payment WHERE payment_id = $1', [paymentId]).then((r) => r.gateway_order_id);
}

async function walletBalance(db: pg.Client, studentId: number): Promise<bigint> {
  const row = await one<{ balance: string }>(db,
    `SELECT COALESCE((SELECT balance_paise FROM wallet WHERE student_id = $1), 0)::text AS balance`, [studentId]);
  return BigInt(row.balance);
}

describe.skipIf(!hasDatabase)('fee payments and D-Wallet database behavior', () => {
  it('applies a fee payment once and exposes one receipt with the saved method', async () => {
    await inRollback(async (db) => {
      const studentId = await studentWithReceiptJoins(db);
      const attempt = await createPayment(db, studentId, 'FEE', 600, 1000);
      const orderId = await createOrderReference(db, attempt.paymentId);
      const paymentRef = `pay_test_${randomBytes(10).toString('hex')}`;

      const before = await db.query('SELECT payment_id FROM v_fee_receipt WHERE payment_id = $1', [attempt.paymentId]);
      expect(before.rows).toEqual([]);
      const first = await applyPayment(db, orderId, paymentRef, 'Card');
      const retried = await applyPayment(db, orderId, paymentRef, 'UPI');

      expect(first.status).toBe('SUCCESS');
      expect(retried).toMatchObject({ payment_id: first.payment_id, receipt_no: first.receipt_no, method: 'Card' });
      const fee = await one<{ online_paid_paise: string; outstanding_paise: string }>(db,
        'SELECT online_paid_paise, outstanding_paise FROM fee_record WHERE fee_record_id = $1', [attempt.feeRecordId]);
      expect(BigInt(fee.online_paid_paise)).toBe(600n);
      expect(BigInt(fee.outstanding_paise)).toBe(400n);

      const receipts = await db.query<{ method: string }>(
        'SELECT method FROM v_fee_receipt WHERE payment_id = $1', [attempt.paymentId]);
      expect(receipts.rows).toEqual([{ method: 'Card' }]);
      const ledger = await db.query('SELECT txn_id FROM wallet_txn WHERE payment_id = $1', [attempt.paymentId]);
      expect(ledger.rows).toEqual([]);
    });
  });

  it('sends one event-keyed fee notification in the payment transaction', async () => {
    await inRollback(async (db) => {
      const studentId = await studentWithReceiptJoins(db);
      const recipient = await one<{ user_id: number }>(db,
        `SELECT user_id FROM app_user WHERE student_id = $1 AND role = 'student' AND is_active`, [studentId]);
      const attempt = await createPayment(db, studentId, 'FEE', 600, 1000);
      const orderId = await createOrderReference(db, attempt.paymentId);
      const paymentRef = `pay_test_${randomBytes(10).toString('hex')}`;

      await applyPayment(db, orderId, paymentRef, 'Card');
      await applyPayment(db, orderId, paymentRef, 'UPI');

      const events = await db.query<{ user_id: number; kind: string; title: string; category: string; link: string; event_key: string }>(
        `SELECT user_id, kind, title, category::text AS category, link, event_key
           FROM notification WHERE event_key = $1`, [`fee-payment:${attempt.paymentId}:succeeded`]);
      expect(events.rows).toEqual([{
        user_id: recipient.user_id,
        kind: 'fees',
        title: 'Fee payment received',
        category: 'Fees',
        link: '/student/fee',
        event_key: `fee-payment:${attempt.paymentId}:succeeded`,
      }]);
    });
  });

  it('credits a D-Wallet top-up once across repeated application calls', async () => {
    await inRollback(async (db) => {
      const studentId = await studentWithReceiptJoins(db);
      const balanceBefore = await walletBalance(db, studentId);
      const attempt = await createPayment(db, studentId, 'TOPUP', 2500);
      const orderId = await createOrderReference(db, attempt.paymentId);
      const paymentRef = `pay_test_${randomBytes(10).toString('hex')}`;

      await applyPayment(db, orderId, paymentRef, 'UPI');
      await applyPayment(db, orderId, paymentRef, 'Card');

      expect((await walletBalance(db, studentId)) - balanceBefore).toBe(2500n);
      const ledger = await one<{ n: number; amount: string; kind: string }>(db,
        `SELECT count(*)::int AS n, sum(amount_paise)::text AS amount, min(kind::text) AS kind
           FROM wallet_txn WHERE payment_id = $1`, [attempt.paymentId]);
      expect(ledger).toMatchObject({ n: 1, amount: '2500', kind: 'TOPUP' });
    });
  });

  it('credits only the excess fee amount to the wallet', async () => {
    await inRollback(async (db) => {
      const studentId = await studentWithReceiptJoins(db);
      const balanceBefore = await walletBalance(db, studentId);
      const attempt = await createPayment(db, studentId, 'FEE', 1400, 1000);
      const orderId = await createOrderReference(db, attempt.paymentId);

      await applyPayment(db, orderId, `pay_test_${randomBytes(10).toString('hex')}`, 'Net Banking');

      const fee = await one<{ online_paid_paise: string; outstanding_paise: string }>(db,
        'SELECT online_paid_paise, outstanding_paise FROM fee_record WHERE fee_record_id = $1', [attempt.feeRecordId]);
      expect(BigInt(fee.online_paid_paise)).toBe(1000n);
      expect(BigInt(fee.outstanding_paise)).toBe(0n);
      expect((await walletBalance(db, studentId)) - balanceBefore).toBe(400n);
      const credit = await one<{ kind: string; amount_paise: string }>(db,
        `SELECT kind::text AS kind, amount_paise::text AS amount_paise
           FROM wallet_txn WHERE payment_id = $1`, [attempt.paymentId]);
      expect(credit).toEqual({ kind: 'EXCESS_CREDIT', amount_paise: '400' });
    });
  });

  it('rolls back payment and fee changes when the gateway payment reference is already used', async () => {
    await inRollback(async (db) => {
      const studentId = await studentWithReceiptJoins(db);
      const first = await createPayment(db, studentId, 'FEE', 200, 1000);
      const second = await createPayment(db, studentId, 'FEE', 300, 1000);
      const firstOrder = await createOrderReference(db, first.paymentId);
      const secondOrder = await createOrderReference(db, second.paymentId);
      const paymentRef = `pay_test_${randomBytes(10).toString('hex')}`;
      await applyPayment(db, firstOrder, paymentRef, 'Card');

      await db.query('SAVEPOINT duplicate_gateway_payment');
      await expect(applyPayment(db, secondOrder, paymentRef, 'UPI')).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT duplicate_gateway_payment');

      const secondPayment = await one<{ status: string; receipt_no: string | null }>(db,
        `SELECT status::text AS status, receipt_no FROM fee_payment WHERE payment_id = $1`, [second.paymentId]);
      const secondFee = await one<{ online_paid_paise: string }>(db,
        'SELECT online_paid_paise FROM fee_record WHERE fee_record_id = $1', [second.feeRecordId]);
      expect(secondPayment).toEqual({ status: 'CREATED', receipt_no: null });
      expect(BigInt(secondFee.online_paid_paise)).toBe(0n);
    });
  });
});
