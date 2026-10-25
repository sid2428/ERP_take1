import crypto from 'node:crypto';

/**
 * Payment gateway helper. No npm package needed: Razorpay's REST API is called with fetch.
 *
 *   RAZORPAY  - real Razorpay (test or live keys). Used automatically when both keys are set.
 *   SIMULATED - a fake gateway for demos when nobody has keys. Opt-in ONLY with PAYMENTS_MODE=simulated,
 *               because anyone signed in could then "pay" without paying. Never use it with real fees.
 *   DISABLED  - no keys and no opt-in: the order endpoints answer "payments are not set up yet".
 *
 * Environment variables:
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET   from Razorpay Dashboard -> API Keys (use rzp_test_ keys)
 *   RAZORPAY_WEBHOOK_SECRET                the secret you type when creating the webhook (optional)
 *   PAYMENTS_MODE=simulated                turns on the simulated gateway
 *   RAZORPAY_API_BASE                      only for tests; defaults to https://api.razorpay.com/v1
 */
export type GatewayMode = 'RAZORPAY' | 'SIMULATED' | 'DISABLED';

export class GatewayError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const apiBase = () => process.env.RAZORPAY_API_BASE ?? 'https://api.razorpay.com/v1';
const keyId = () => process.env.RAZORPAY_KEY_ID ?? '';
const keySecret = () => process.env.RAZORPAY_KEY_SECRET ?? '';
const simulatedSecret = () => process.env.SIMULATED_PAYMENT_SECRET ?? 'erp-simulated-gateway';

export function gatewayMode(): GatewayMode {
  if ((process.env.PAYMENTS_MODE ?? '').toLowerCase() === 'simulated' && process.env.NODE_ENV !== 'production') {
    return 'SIMULATED';
  }
  return keyId() && keySecret() ? 'RAZORPAY' : 'DISABLED';
}

/** True for rzp_test_ keys and for the simulated gateway: no real money moves. */
export const isTestMode = (): boolean => gatewayMode() === 'SIMULATED' || keyId().startsWith('rzp_test_');

/** The key id the browser may see. Never the secret. */
export const publicKeyId = (): string => (gatewayMode() === 'SIMULATED' ? 'simulated' : keyId());

// ---------------------------------------------------------------------------------------
async function razorpay<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keyId()}:${keySecret()}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GatewayError('Could not reach the payment gateway. Please try again.');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { error?: { description?: string } }).error?.description ?? ''; } catch { /* not JSON */ }
    console.error('Razorpay', method, path, res.status, detail);
    throw new GatewayError('The payment gateway rejected the request. Please try again.');
  }
  return (await res.json()) as T;
}

/** Create the order the browser will pay against. Returns the gateway's order id. */
export async function createGatewayOrder(amountPaise: number, receipt: string, notes: Record<string, string>): Promise<string> {
  if (gatewayMode() === 'SIMULATED') return 'order_SIM_' + crypto.randomBytes(8).toString('hex');
  const order = await razorpay<{ id: string }>('POST', '/orders', {
    amount: amountPaise, currency: 'INR', receipt: receipt.slice(0, 40), notes,
  });
  return order.id;
}

// ---------------------------------------------------------------------------------------
const hmac = (secret: string, data: string | Buffer) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Razorpay Checkout returns a signature over "order_id|payment_id", signed with your key secret. */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
  const secret = gatewayMode() === 'SIMULATED' ? simulatedSecret() : keySecret();
  return !!secret && safeEqual(hmac(secret, `${orderId}|${paymentId}`), signature);
}

/** Webhooks are signed over the RAW request body with the webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
  return !!secret && safeEqual(hmac(secret, rawBody), signature);
}

// ---- simulated gateway only ----
export const newSimulatedPaymentId = (): string => 'pay_SIM_' + crypto.randomBytes(8).toString('hex');
export const signSimulated = (orderId: string, paymentId: string): string => hmac(simulatedSecret(), `${orderId}|${paymentId}`);

// ---------------------------------------------------------------------------------------
const METHOD_LABEL: Record<string, string> = {
  card: 'Card', upi: 'UPI', netbanking: 'Net Banking', wallet: 'Wallet', emi: 'EMI', paylater: 'Pay Later',
};
export const methodLabel = (method?: string): string => (method && METHOD_LABEL[method]) || 'Online';

interface GatewayPayment { id: string; order_id: string; amount: number; status: string; method?: string }

/**
 * Ask Razorpay what really happened to this payment (a valid signature is necessary but this makes
 * sure the order, the amount and the capture all match). Returns the method label for the receipt.
 */
export async function confirmGatewayPayment(paymentId: string, orderId: string, amountPaise: number): Promise<string> {
  if (gatewayMode() === 'SIMULATED') return 'Simulated';
  const path = `/payments/${encodeURIComponent(paymentId)}`;
  let payment = await razorpay<GatewayPayment>('GET', path);
  if (payment.order_id !== orderId || Number(payment.amount) !== amountPaise) {
    throw new GatewayError('The payment details do not match the order. Nothing was marked paid.', 400);
  }
  if (payment.status === 'authorized') {
    payment = await razorpay<GatewayPayment>('POST', `${path}/capture`, { amount: amountPaise, currency: 'INR' });
  }
  if (payment.status !== 'captured') {
    throw new GatewayError('The payment has not been completed yet.', 409);
  }
  return methodLabel(payment.method);
}
