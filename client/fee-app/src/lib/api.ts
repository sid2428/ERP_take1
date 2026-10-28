import type {
  FeeStatement, OrderResponse, Payment, RazorpayResponse, Student, VerifyResult, Wallet,
} from '../types';
import { sampleStatement, samplePayments, sampleStudent, sampleWallet } from './sampleData';

// The finance router is mounted inside the authenticated student router.
// Keep the production bundle deterministic and aligned with that mount.
const BASE = '/student/fee/api';
export const SAMPLE_MODE = import.meta.env.VITE_USE_SAMPLE_DATA === 'true';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

const csrf = () => document.getElementById('fee-root')?.getAttribute('data-csrf') ?? '';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { credentials: 'include', headers: { Accept: 'application/json' }, ...init });
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
    // the portal answered with a page (sign-in redirect or error page), not data
    throw new ApiError('Your session has expired. Please refresh the page and sign in again.', res.status === 403 ? 403 : 401);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((data as { message?: string } | null)?.message ?? res.statusText, res.status);
  return data as T;
}

/** Same format as the portal's own forms: form-encoded, with the CSRF token in the body. */
const post = <T>(path: string, body: object = {}) =>
  req<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf() },
    body: new URLSearchParams({
      ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])),
      _csrf: csrf(),
    }).toString(),
  });

const needsBackend = (): never => {
  throw new ApiError('Sample mode: payments need your backend and Razorpay keys.', 0);
};

// ---- Reads (the backend is the single source of truth) ----
export const getStudent = (): Promise<Student> => SAMPLE_MODE ? Promise.resolve(sampleStudent) : req('/student/me');
export const getStatement = (): Promise<FeeStatement> => SAMPLE_MODE ? Promise.resolve(sampleStatement) : req('/fees/statement');
export const getPayments = (): Promise<Payment[]> => SAMPLE_MODE ? Promise.resolve(samplePayments) : req('/fees/payments');
export const getWallet = (): Promise<Wallet> => SAMPLE_MODE ? Promise.resolve(sampleWallet) : req('/wallet');

// ---- Payments ----
/** The server decides the fee amount from its own records; the client sends no amount. */
export const createFeeOrder = async (): Promise<OrderResponse> => SAMPLE_MODE ? needsBackend() : post('/payments/fee/order');
/** The server validates the amount (min/max) again. */
export const createTopupOrder = async (amount: number): Promise<OrderResponse> =>
  SAMPLE_MODE ? needsBackend() : post('/wallet/topup/order', { amount });
/** The server checks the Razorpay signature and only then marks the fee paid / credits the wallet. */
export const verifyPayment = (r: RazorpayResponse): Promise<VerifyResult> => post('/payments/verify', r);
/** Simulated gateway only: asks the server to sign a test payment for this order. */
export const simulatePayment = (orderId: string): Promise<RazorpayResponse> =>
  post('/payments/simulate', { orderId });
/** Lets the server record a failed or cancelled attempt (these never count as money paid). */
export const reportOutcome = (orderId: string, status: 'FAILED' | 'CANCELLED', reason?: string) =>
  post<void>('/payments/outcome', { orderId, status, reason }).catch(() => undefined);

export async function downloadReceiptPdf(paymentId: string, fileName: string) {
  const res = await fetch(`${BASE}/fees/receipt/${encodeURIComponent(paymentId)}/pdf`, { credentials: 'include' });
  if (!res.ok) throw new ApiError('Could not download the receipt.', res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}
