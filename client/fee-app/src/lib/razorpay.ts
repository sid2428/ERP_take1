import { ApiError, reportOutcome, verifyPayment } from './api';
import type { OrderResponse, RazorpayResponse, VerifyResult } from '../types';

interface RazorpayOptions {
  key: string; amount: number; currency: string; order_id: string; name: string; description: string;
  prefill?: { name?: string; email?: string; contact?: string };
  theme?: { color: string };
  handler: (r: RazorpayResponse) => void;
  modal?: { ondismiss?: () => void };
}
interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (r: { error: { description: string } }) => void): void;
}
declare global { interface Window { Razorpay?: new (o: RazorpayOptions) => RazorpayInstance } }

let scriptPromise: Promise<void> | null = null;
function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('Could not load Razorpay Checkout. Check your internet connection.')); };
    document.body.appendChild(s);
  });
  return scriptPromise;
}

export type CheckoutOutcome =
  | { kind: 'success'; result: VerifyResult }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'processing' }; // paid at the gateway but server confirmation not received yet

interface Args {
  createOrder: () => Promise<OrderResponse>;
  description: string;
  prefill?: { name?: string; email?: string; contact?: string };
}

/**
 * Opens Razorpay's own Checkout popup for an order created by YOUR backend.
 * Resolves exactly once. Money is only treated as paid when the backend verifies the signature.
 */
export async function runCheckout({ createOrder, description, prefill }: Args): Promise<CheckoutOutcome> {
  await loadCheckoutScript();
  const order = await createOrder();

  return new Promise<CheckoutOutcome>((resolve) => {
    let settled = false;
    let paying = false;
    let lastFailure: string | null = null;
    const finish = (o: CheckoutOutcome) => { if (!settled) { settled = true; resolve(o); } };

    const rzp = new window.Razorpay!({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      order_id: order.orderId,
      name: 'PICT Student Portal',
      description,
      prefill,
      theme: { color: '#1F3A6E' },
      handler: async (response) => {
        paying = true;
        try {
          finish({ kind: 'success', result: await verifyPayment(response) });
        } catch (e) {
          // 4xx = signature rejected. Anything else (network/5xx) = unknown, the webhook will settle it.
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
            finish({ kind: 'failed', reason: e.message || 'Payment could not be verified.' });
          } else {
            finish({ kind: 'processing' });
          }
        }
      },
      modal: {
        ondismiss: () => {
          if (paying) return; // popup closes itself after a successful payment
          if (lastFailure) {
            void reportOutcome(order.orderId, 'FAILED', lastFailure);
            finish({ kind: 'failed', reason: lastFailure });
          } else {
            void reportOutcome(order.orderId, 'CANCELLED');
            finish({ kind: 'cancelled' });
          }
        },
      },
    });
    // The student can retry inside the popup, so a failure only becomes final when the popup is closed.
    rzp.on('payment.failed', (r) => { lastFailure = r.error.description; });
    rzp.open();
  });
}
