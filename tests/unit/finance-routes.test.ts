import express, { type Request } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  friendlyDbError: vi.fn(),
  audit: vi.fn(),
  gatewayMode: vi.fn(),
  isTestMode: vi.fn(),
  createGatewayOrder: vi.fn(),
  publicKeyId: vi.fn(),
  confirmGatewayPayment: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
  buildReceiptPdf: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
  friendlyDbError: mocks.friendlyDbError,
}));
vi.mock('../../src/lib/audit.js', () => ({ audit: mocks.audit }));
vi.mock('../../src/lib/payments.js', () => ({
  GatewayError: class GatewayError extends Error { status = 502; },
  confirmGatewayPayment: mocks.confirmGatewayPayment,
  createGatewayOrder: mocks.createGatewayOrder,
  gatewayMode: mocks.gatewayMode,
  isTestMode: mocks.isTestMode,
  methodLabel: vi.fn((method?: string) => method ?? 'Online'),
  newSimulatedPaymentId: vi.fn(),
  publicKeyId: mocks.publicKeyId,
  signSimulated: vi.fn(),
  verifyCheckoutSignature: mocks.verifyCheckoutSignature,
  verifyWebhookSignature: vi.fn(),
}));
vi.mock('../../src/lib/receipt-pdf.js', () => ({ buildReceiptPdf: mocks.buildReceiptPdf }));

import { financeApiRouter } from '../../src/routes/finance-routes.js';

type CurrentUser = NonNullable<Request['user']>;

const student: CurrentUser = {
  userId: 40,
  loginId: 'STU40',
  role: 'student',
  studentId: 400,
  facultyId: null,
  displayName: 'Student Example',
  deptId: null,
  mustChangePassword: false,
};

const payment = (status: string) => ({
  payment_id: 7,
  purpose: 'FEE' as const,
  status,
  amount_paise: '125000',
  gateway_order_id: 'order-test-7',
  gateway_payment_id: status === 'SUCCESS' ? 'pay-test-7' : null,
  receipt_no: status === 'SUCCESS' ? 'RCPT-2026-000007' : null,
  method: status === 'SUCCESS' ? 'Card' : null,
  paid_at: status === 'SUCCESS' ? new Date('2026-10-25T12:00:00Z') : null,
});

function appAs(user?: CurrentUser): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use(financeApiRouter);
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue([]);
  mocks.queryOne.mockResolvedValue(undefined);
  mocks.friendlyDbError.mockReturnValue(null);
  mocks.audit.mockResolvedValue(undefined);
  mocks.gatewayMode.mockReturnValue('RAZORPAY');
  mocks.isTestMode.mockReturnValue(false);
  mocks.createGatewayOrder.mockResolvedValue('order-test-7');
  mocks.publicKeyId.mockReturnValue('rzp_test_public');
  mocks.confirmGatewayPayment.mockResolvedValue('Card');
  mocks.verifyCheckoutSignature.mockReturnValue(true);
  mocks.buildReceiptPdf.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fee payment routes', () => {
  it('returns an empty statement when the student has no fee record', async () => {
    const response = await request(appAs(student)).get('/fees/statement');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      academicYear: '', components: [], amountPaid: 0, status: 'PENDING', hasRecord: false,
    });
    expect(mocks.queryOne.mock.calls[0]?.[1]).toEqual([student.studentId]);
  });

  it('does not enable simulated payments in production without Razorpay keys', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENTS_MODE', 'simulated');
    vi.stubEnv('RAZORPAY_KEY_ID', '');
    vi.stubEnv('RAZORPAY_KEY_SECRET', '');

    const { gatewayMode } = await vi.importActual<typeof import('../../src/lib/payments.js')>(
      '../../src/lib/payments.js',
    );

    expect(gatewayMode()).toBe('DISABLED');
  });

  it('keeps opted-in simulated payments available outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('PAYMENTS_MODE', 'simulated');
    vi.stubEnv('RAZORPAY_KEY_ID', '');
    vi.stubEnv('RAZORPAY_KEY_SECRET', '');

    const { gatewayMode } = await vi.importActual<typeof import('../../src/lib/payments.js')>(
      '../../src/lib/payments.js',
    );

    expect(gatewayMode()).toBe('SIMULATED');
  });

  it('uses Razorpay in production when both gateway keys are configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PAYMENTS_MODE', 'simulated');
    vi.stubEnv('RAZORPAY_KEY_ID', 'rzp_live_test');
    vi.stubEnv('RAZORPAY_KEY_SECRET', 'configured-test-secret');

    const { gatewayMode } = await vi.importActual<typeof import('../../src/lib/payments.js')>(
      '../../src/lib/payments.js',
    );

    expect(gatewayMode()).toBe('RAZORPAY');
  });

  it('requires a signed-in student and rejects other roles', async () => {
    const unauthenticated = await request(appAs()).get('/fees/payments');
    const faculty = await request(appAs({ ...student, role: 'faculty', studentId: null, facultyId: 12 }))
      .get('/fees/payments');

    expect(unauthenticated.status).toBe(401);
    expect(faculty.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('does not accept a client-supplied successful payment outcome', async () => {
    const response = await request(appAs(student))
      .post('/payments/outcome')
      .send({ orderId: 'order-test-7', status: 'SUCCESS' });

    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('takes the fee order amount from the student fee record, not the request body', async () => {
    mocks.queryOne.mockResolvedValue({ fee_record_id: 'FEE-STU40', outstanding_paise: '125000' });

    const response = await request(appAs(student))
      .post('/payments/fee/order')
      .send({ amount: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ orderId: 'order-test-7', amount: 125000 });
    expect(mocks.createGatewayOrder).toHaveBeenCalledWith(125000, 'FEE-STU40', {
      purpose: 'FEE', student_id: String(student.studentId),
    });
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([
      student.studentId, 'FEE-STU40', 'FEE', 'RAZORPAY', 'order-test-7', 125000,
    ]);
  });

  it('records a failure only against the student-owned order while it is still created', async () => {
    const response = await request(appAs(student))
      .post('/payments/outcome')
      .send({ orderId: 'order-test-7', status: 'FAILED', reason: 'declined' });

    expect(response.status).toBe(200);
    expect(mocks.query.mock.calls[0]?.[0]).toContain('WHERE gateway_order_id = $1 AND student_id = $2 AND status = \'CREATED\'');
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(['order-test-7', student.studentId, 'FAILED', 'declined']);
  });

  it('scopes verification to the signed-in student and rejects a bad signature', async () => {
    mocks.queryOne.mockResolvedValue(payment('CREATED'));
    mocks.verifyCheckoutSignature.mockReturnValue(false);

    const response = await request(appAs(student)).post('/payments/verify')
      .send({ razorpay_order_id: 'order-test-7', razorpay_payment_id: 'pay-test-7', razorpay_signature: 'bad' });

    expect(response.status).toBe(400);
    expect(mocks.queryOne.mock.calls[0]?.[0]).toContain('WHERE gateway_order_id = $1 AND student_id = $2');
    expect(mocks.queryOne.mock.calls[0]?.[1]).toEqual(['order-test-7', student.studentId]);
    expect(mocks.confirmGatewayPayment).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('does not apply or issue another receipt when a successful verification is retried', async () => {
    const completed = payment('SUCCESS');
    mocks.queryOne
      .mockResolvedValueOnce(payment('CREATED'))
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed);

    const payload = {
      razorpay_order_id: 'order-test-7',
      razorpay_payment_id: 'pay-test-7',
      razorpay_signature: 'valid-test-signature',
    };
    const first = await request(appAs(student)).post('/payments/verify').send(payload);
    const retry = await request(appAs(student)).post('/payments/verify').send(payload);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(first.body.receiptNo).toBe('RCPT-2026-000007');
    expect(retry.body.paymentId).toBe(first.body.paymentId);
    expect(mocks.queryOne.mock.calls.filter(([sql]) => String(sql).includes('FROM apply_fee_payment'))).toHaveLength(1);
    expect(mocks.confirmGatewayPayment).toHaveBeenCalledTimes(1);
  });

  it('rejects a different payment ID for an already-successful order without changing it', async () => {
    mocks.queryOne.mockResolvedValue(payment('SUCCESS'));

    const response = await request(appAs(student)).post('/payments/verify')
      .send({
        razorpay_order_id: 'order-test-7',
        razorpay_payment_id: 'pay-test-other',
        razorpay_signature: 'valid-test-signature',
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/payment ID does not match/i);
    expect(mocks.queryOne).toHaveBeenCalledTimes(1);
    expect(mocks.confirmGatewayPayment).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('restricts receipt lookup to the signed-in student', async () => {
    const response = await request(appAs(student)).get('/fees/receipt/17/pdf');

    expect(response.status).toBe(404);
    expect(mocks.queryOne.mock.calls[0]?.[0]).toContain('WHERE payment_id = $1 AND student_id = $2');
    expect(mocks.queryOne.mock.calls[0]?.[1]).toEqual([17, student.studentId]);
    expect(mocks.buildReceiptPdf).not.toHaveBeenCalled();
  });

  it('scopes D-Wallet balance and ledger reads to the signed-in student', async () => {
    const at = new Date('2026-10-25T12:00:00Z');
    mocks.queryOne.mockResolvedValue({ balance_paise: '5500' });
    mocks.query.mockResolvedValue([{
      txn_id: 9, created_at: at, kind: 'TOPUP', amount_paise: '5500', description: 'D-Wallet top-up',
    }]);

    const response = await request(appAs(student)).get('/wallet');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ balance: 55, transactions: [{ type: 'CREDIT', amount: 55 }] });
    expect(mocks.queryOne.mock.calls[0]?.[1]).toEqual([student.studentId]);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([student.studentId]);
  });
});
