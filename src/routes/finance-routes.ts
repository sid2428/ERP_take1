import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { friendlyDbError, query, queryOne } from '../db.js';
import { audit } from '../lib/audit.js';
import {
  GatewayError, confirmGatewayPayment, createGatewayOrder, gatewayMode, isTestMode, methodLabel,
  newSimulatedPaymentId, publicKeyId, signSimulated, verifyCheckoutSignature, verifyWebhookSignature,
} from '../lib/payments.js';
import { buildReceiptPdf, type ReceiptRow } from '../lib/receipt-pdf.js';

/** Wallet top-up limits in rupees. Keep these in step with the limits in the AddMoney dialog. */
export const TOPUP_MIN_RUPEES = 100;
export const TOPUP_MAX_RUPEES = 20000;

class ApiFail extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const rupees = (paise: string | number) => Number(paise) / 100;

/** Wraps a handler: passes the signed-in student's id, and turns every failure into {message} JSON. */
const route = (handler: (req: Request, res: Response, studentId: number) => Promise<unknown>) =>
  (req: Request, res: Response, _next: NextFunction): void => {
    handler(req, res, req.user!.studentId!).catch((err: unknown) => {
      if (err instanceof ApiFail || err instanceof GatewayError) {
        res.status(err.status).json({ message: err.message });
        return;
      }
      console.error(err);
      res.status(500).json({ message: friendlyDbError(err) ?? 'Something went wrong. Please try again.' });
    });
  };

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiFail(400, result.error.issues[0]?.message ?? 'Invalid request.');
  return result.data;
}

function requireGateway(): void {
  if (gatewayMode() === 'DISABLED') {
    throw new ApiFail(503, 'Online payments are not set up yet. Please contact the accounts office.');
  }
}

interface PayRow {
  payment_id: number;
  purpose: 'FEE' | 'TOPUP';
  status: string;
  amount_paise: string;
  gateway_order_id: string;
  gateway_payment_id: string | null;
  receipt_no: string | null;
  method: string | null;
  paid_at: Date | null;
}
const PAY_COLS = `payment_id, purpose::text AS purpose, status::text AS status, amount_paise,
                  gateway_order_id, gateway_payment_id, receipt_no, method, paid_at`;

const toVerifyResult = (p: PayRow) => ({
  purpose: p.purpose === 'FEE' ? 'FEE' : 'WALLET_TOPUP',
  paymentId: String(p.payment_id),
  referenceId: p.gateway_payment_id ?? p.gateway_order_id,
  receiptNo: p.receipt_no ?? '',
  amount: rupees(p.amount_paise),
  method: p.method ?? 'Online',
  paidAt: (p.paid_at ?? new Date()).toISOString(),
  isTest: isTestMode(),
});

// =========================================================================================
//  Student API. Mount it INSIDE studentRouter (student-routes.ts):
//      studentRouter.use('/fee/api', financeApiRouter);
//  so it inherits requireLogin + requireRole('student') and the CSRF check, and the browser calls
//  /student/fee/api/...  (VITE_API_BASE_URL=/student/fee/api). POST bodies are form-encoded with
//  _csrf, exactly like the portal's own forms, because app.ts parses forms before the CSRF check.
// =========================================================================================
export const financeApiRouter = Router();

financeApiRouter.use(express.json({ limit: '10kb' }));
financeApiRouter.use((req, res, next) => {
  if (!req.user) { res.status(401).json({ message: 'Please sign in again.' }); return; }
  if (req.user.role !== 'student' || !req.user.studentId) {
    res.status(403).json({ message: 'Only students can use this page.' });
    return;
  }
  next();
});

// ---- Reads ----------------------------------------------------------------------------
financeApiRouter.get('/student/me', route(async (_req, res, studentId) => {
  const s = await queryOne<{
    student_number: string; first_name: string; last_name: string; admission_number: string;
    category: string; email: string; mobile_number: string; program_name: string; dept_name: string;
  }>(
    `SELECT s.student_number, s.first_name, s.last_name, s.admission_number, s.category::text AS category,
            s.email, s.mobile_number, p.program_name, d.dept_name
       FROM student s
       JOIN program p ON p.program_id = s.program_id
       JOIN department d ON d.dept_id = p.dept_id
      WHERE s.student_id = $1`, [studentId]);
  if (!s) throw new ApiFail(404, 'Student record not found.');
  res.json({
    name: `${s.first_name} ${s.last_name}`,
    initials: (s.first_name[0] + s.last_name[0]).toUpperCase(),
    studentNo: s.student_number,
    admissionNo: s.admission_number,
    department: s.dept_name,
    program: s.program_name,
    category: s.category,
    email: s.email,
    phone: s.mobile_number,
  });
}));

financeApiRouter.get('/fees/statement', route(async (_req, res, studentId) => {
  const f = await queryOne<{
    academic_year: string; tuition_paise: string; development_paise: string; examination_paise: string;
    other_paise: string; late_fee_paise: string; paid_paise: string; fee_status: string;
  }>(
    `SELECT academic_year, tuition_paise, development_paise, examination_paise, other_paise,
            late_fee_paise, paid_paise, fee_status::text AS fee_status
       FROM fee_record WHERE student_id = $1 ORDER BY academic_year DESC LIMIT 1`, [studentId]);
  if (!f) throw new ApiFail(404, 'No fee record was found for your account.');

  const components = [
    { id: 'tuition', name: 'Tuition Fee', amount: rupees(f.tuition_paise) },
    { id: 'development', name: 'Development Fee', amount: rupees(f.development_paise) },
    { id: 'examination', name: 'Examination Fee', amount: rupees(f.examination_paise) },
    { id: 'other', name: 'Other Fee', amount: rupees(f.other_paise) },
  ];
  if (Number(f.late_fee_paise) > 0) components.push({ id: 'late', name: 'Late Fee', amount: rupees(f.late_fee_paise) });

  res.json({
    academicYear: f.academic_year,
    components,
    amountPaid: rupees(f.paid_paise),
    status: f.fee_status === 'PAID' ? 'PAID' : 'PENDING',
  });
}));

financeApiRouter.get('/fees/payments', route(async (_req, res, studentId) => {
  const rows = await query<PayRow & { at: Date; academic_year: string | null; gateway: string }>(
    `SELECT p.payment_id, p.purpose::text AS purpose, p.status::text AS status, p.amount_paise,
            p.gateway_order_id, p.gateway_payment_id, p.receipt_no, p.method, p.paid_at,
            COALESCE(p.paid_at, p.created_at) AS at, f.academic_year, p.gateway::text AS gateway
       FROM fee_payment p LEFT JOIN fee_record f ON f.fee_record_id = p.fee_record_id
      WHERE p.student_id = $1
        AND (p.status <> 'CREATED' OR p.created_at > now() - interval '30 minutes')  -- hide abandoned orders
      ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.payment_id DESC
      LIMIT 100`, [studentId]);
  res.json(rows.map((p) => ({
    id: String(p.payment_id),
    date: p.at.toISOString(),
    academicYear: p.academic_year ?? '-',
    description: p.purpose === 'FEE' ? `Academic fee ${p.academic_year}` : 'D-Wallet top-up',
    referenceId: p.gateway_payment_id ?? p.gateway_order_id,
    method: p.method ?? '-',
    amount: rupees(p.amount_paise),
    status: p.status === 'CREATED' ? 'PENDING' : p.status,
    receiptNo: p.receipt_no ?? undefined,
    isTest: p.gateway === 'SIMULATED' || isTestMode(),
  })));
}));

financeApiRouter.get('/wallet', route(async (_req, res, studentId) => {
  const w = await queryOne<{ balance_paise: string }>('SELECT balance_paise FROM wallet WHERE student_id = $1', [studentId]);
  const tx = await query<{ txn_id: number; created_at: Date; kind: string; amount_paise: string; description: string | null }>(
    `SELECT txn_id, created_at, kind::text AS kind, amount_paise, description
       FROM wallet_txn WHERE student_id = $1 ORDER BY created_at DESC, txn_id DESC LIMIT 50`, [studentId]);
  res.json({
    balance: rupees(w?.balance_paise ?? 0),
    transactions: tx.map((t) => ({
      id: String(t.txn_id),
      date: t.created_at.toISOString(),
      description: t.description ?? t.kind,
      type: Number(t.amount_paise) >= 0 ? 'CREDIT' : 'DEBIT',
      amount: Math.abs(rupees(t.amount_paise)),
      status: 'COMPLETED',
    })),
  });
}));

// ---- Creating an order ------------------------------------------------------------------
/** Records the attempt, asks the gateway for an order, and returns what the browser needs to pay. */
async function startPayment(
  res: Response, studentId: number,
  p: { purpose: 'FEE' | 'TOPUP'; feeRecordId: string | null; amountPaise: number; receipt: string },
): Promise<void> {
  const orderId = await createGatewayOrder(p.amountPaise, p.receipt, { purpose: p.purpose, student_id: String(studentId) });
  await query(
    `INSERT INTO fee_payment (student_id, fee_record_id, purpose, gateway, gateway_order_id, amount_paise)
     VALUES ($1, $2, $3::payment_purpose, $4::payment_gateway, $5, $6)`,
    [studentId, p.feeRecordId, p.purpose, gatewayMode() === 'SIMULATED' ? 'SIMULATED' : 'RAZORPAY', orderId, p.amountPaise]);
  res.json({ orderId, amount: p.amountPaise, currency: 'INR', keyId: publicKeyId() });
}

// The amount comes from the database, never from the browser.
financeApiRouter.post('/payments/fee/order', route(async (_req, res, studentId) => {
  requireGateway();
  const f = await queryOne<{ fee_record_id: string; outstanding_paise: string }>(
    `SELECT fee_record_id, outstanding_paise FROM fee_record
      WHERE student_id = $1 ORDER BY academic_year DESC LIMIT 1`, [studentId]);
  if (!f) throw new ApiFail(404, 'No fee record was found for your account.');
  const amountPaise = Number(f.outstanding_paise);
  if (amountPaise <= 0) throw new ApiFail(409, 'Your fee is already paid in full.');
  await startPayment(res, studentId, { purpose: 'FEE', feeRecordId: f.fee_record_id, amountPaise, receipt: f.fee_record_id });
}));

const topupSchema = z.object({
  amount: z.coerce.number('Enter an amount.').int('Enter a whole number of rupees.')   // form fields arrive as text
    .min(TOPUP_MIN_RUPEES, `The minimum top-up is Rs. ${TOPUP_MIN_RUPEES}.`)
    .max(TOPUP_MAX_RUPEES, `The maximum top-up is Rs. ${TOPUP_MAX_RUPEES}.`),
});

financeApiRouter.post('/wallet/topup/order', route(async (req, res, studentId) => {
  requireGateway();
  const { amount } = parse(topupSchema, req.body);
  await startPayment(res, studentId, {
    purpose: 'TOPUP', feeRecordId: null, amountPaise: amount * 100, receipt: `TOPUP-${studentId}-${Date.now()}`,
  });
}));

// ---- Confirming a payment -------------------------------------------------------------
const verifySchema = z.object({
  razorpay_order_id: z.string().min(1).max(60),
  razorpay_payment_id: z.string().min(1).max(60),
  razorpay_signature: z.string().min(1).max(200),
});

financeApiRouter.post('/payments/verify', route(async (req, res, studentId) => {
  const b = parse(verifySchema, req.body);
  // only the student who owns the order can confirm it
  const pay = await queryOne<PayRow>(
    `SELECT ${PAY_COLS} FROM fee_payment WHERE gateway_order_id = $1 AND student_id = $2`,
    [b.razorpay_order_id, studentId]);
  if (!pay) throw new ApiFail(404, 'We could not find that payment order.');

  let done = pay;
  if (pay.status !== 'SUCCESS') {                               // SUCCESS already = the webhook got here first
    requireGateway();
    if (!verifyCheckoutSignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature)) {
      throw new ApiFail(400, 'The payment signature could not be verified. Nothing was marked paid.');
    }
    const method = await confirmGatewayPayment(b.razorpay_payment_id, b.razorpay_order_id, Number(pay.amount_paise));
    // one database call = one transaction: payment, receipt, fee record / wallet. Safe to repeat.
    const applied = await queryOne<PayRow>(
      `SELECT ${PAY_COLS} FROM apply_fee_payment($1, $2, $3)`, [b.razorpay_order_id, b.razorpay_payment_id, method]);
    if (!applied) throw new ApiFail(500, 'The payment could not be recorded. Please contact the accounts office.');
    done = applied;
    await audit(req, {
      action: 'PAYMENT_SUCCESS', entity: 'fee_payment', entityId: String(done.payment_id),
      details: { purpose: done.purpose, amount_paise: done.amount_paise, receipt_no: done.receipt_no, method },
    });
  }
  res.json(toVerifyResult(done));
}));

// The browser tells us when the attempt failed or was cancelled. It can never undo a success.
financeApiRouter.post('/payments/outcome', route(async (req, res, studentId) => {
  const b = parse(z.object({
    orderId: z.string().min(1).max(60),
    status: z.enum(['FAILED', 'CANCELLED']),
    reason: z.string().max(200).optional(),
  }), req.body);
  await query(
    `UPDATE fee_payment SET status = $3::payment_status, failure_reason = $4
      WHERE gateway_order_id = $1 AND student_id = $2 AND status = 'CREATED'`,
    [b.orderId, studentId, b.status, b.reason ?? null]);
  res.json({ ok: true });
}));

// Simulated gateway only: stands in for the Razorpay popup by signing a fake payment for YOUR order.
financeApiRouter.post('/payments/simulate', route(async (req, res, studentId) => {
  if (gatewayMode() !== 'SIMULATED') throw new ApiFail(404, 'Not available.');
  const { orderId } = parse(z.object({ orderId: z.string().min(1).max(60) }), req.body);
  const pay = await queryOne<PayRow>(
    `SELECT ${PAY_COLS} FROM fee_payment WHERE gateway_order_id = $1 AND student_id = $2 AND status <> 'SUCCESS'`,
    [orderId, studentId]);
  if (!pay) throw new ApiFail(404, 'We could not find that payment order.');
  const paymentId = newSimulatedPaymentId();
  res.json({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signSimulated(orderId, paymentId) });
}));

// ---- Receipt PDF ------------------------------------------------------------------------
financeApiRouter.get('/fees/receipt/:paymentId/pdf', route(async (req, res, studentId) => {
  const paymentId = parse(z.coerce.number().int().positive(), req.params.paymentId);
  const r = await queryOne<ReceiptRow & { gateway: string }>(
    'SELECT * FROM v_fee_receipt WHERE payment_id = $1 AND student_id = $2', [paymentId, studentId]);
  if (!r) throw new ApiFail(404, 'Receipt not found.');
  const pdf = await buildReceiptPdf(r, r.gateway === 'SIMULATED' || isTestMode());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${r.receipt_no}.pdf"`);
  res.send(Buffer.from(pdf));
}));

// =========================================================================================
//  Razorpay webhook: the safety net when the student closes the tab right after paying.
//  Mount this in app.ts BEFORE express.urlencoded(), the session and the CSRF middleware:
//    the signature is checked against the RAW body, and Razorpay cannot send a CSRF token.
//  Dashboard -> Webhooks: URL https://<your-site>/webhooks/razorpay, events payment.captured and
//  payment.failed, and put the secret you type there into RAZORPAY_WEBHOOK_SECRET.
// =========================================================================================
export const razorpayWebhookRouter = Router();

razorpayWebhookRouter.post('/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  handleWebhook(req, res).catch((err: unknown) => {
    console.error('webhook', err);
    res.status(500).json({ ok: false });                          // Razorpay retries on a non-2xx answer
  });
});

async function handleWebhook(req: Request, res: Response): Promise<void> {
  const raw: unknown = req.body;
  if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(raw, req.header('x-razorpay-signature') ?? '')) {
    res.status(400).json({ ok: false });
    return;
  }
  let event: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; method?: string; error_description?: string } } } };
  try { event = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ ok: false }); return; }

  const p = event.payload?.payment?.entity;
  if (p?.id && p.order_id) {
    const pay = await queryOne<PayRow>(`SELECT ${PAY_COLS} FROM fee_payment WHERE gateway_order_id = $1`, [p.order_id]);
    if (pay && pay.status !== 'SUCCESS') {
      if ((event.event === 'payment.captured' || event.event === 'order.paid') && Number(p.amount) === Number(pay.amount_paise)) {
        const applied = await queryOne<PayRow>(
          `SELECT ${PAY_COLS} FROM apply_fee_payment($1, $2, $3)`, [p.order_id, p.id, methodLabel(p.method)]);
        if (applied) {
          await query(
            `INSERT INTO audit_log (action, entity, entity_id, details) VALUES ('PAYMENT_WEBHOOK', 'fee_payment', $1, $2)`,
            [String(applied.payment_id), JSON.stringify({ event: event.event, receipt_no: applied.receipt_no })]);
        }
      } else if (event.event === 'payment.failed') {
        await query(
          `UPDATE fee_payment SET status = 'FAILED', failure_reason = $2 WHERE gateway_order_id = $1 AND status = 'CREATED'`,
          [p.order_id, (p.error_description ?? 'Payment failed').slice(0, 200)]);
      }
    }
  }
  res.json({ ok: true });
}
