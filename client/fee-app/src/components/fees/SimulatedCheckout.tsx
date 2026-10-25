import { useEffect, useRef, useState } from 'react';
import { reportOutcome, simulatePayment, verifyPayment } from '../../lib/api';
import { runCheckout, type CheckoutOutcome } from '../../lib/razorpay';
import type { OrderResponse } from '../../types';

/**
 * The portal's own payment window, used when the server runs the simulated gateway
 * (PAYMENTS_MODE=simulated). With real Razorpay keys the order carries a real key id and
 * Razorpay's popup is used exactly as before, so nothing else in the app changes.
 *
 * No card or bank details are collected here: it only lets you complete or fail the payment.
 */
type CheckoutOptions = Parameters<typeof runCheckout>[0];
interface PendingPayment {
  order: OrderResponse;
  description: string;
  studentName?: string;
  done: (outcome: CheckoutOutcome) => void;
}

let openWindow: ((p: PendingPayment) => void) | null = null;    // set while <SimulatedCheckoutHost /> is mounted
const PROCESSING_MS = 900;

/** Drop-in replacement for runCheckout(): creates the order, then picks the right payment window. */
export async function runCheckoutAuto(opts: CheckoutOptions): Promise<CheckoutOutcome> {
  const order = await opts.createOrder();
  if (order.keyId !== 'simulated') {
    return runCheckout({ ...opts, createOrder: async () => order });          // real Razorpay, same order
  }
  const show = openWindow;
  if (!show) throw new Error('The payment window is not ready. Please refresh the page.');
  const studentName = (opts.prefill as { name?: string } | undefined)?.name;
  return new Promise<CheckoutOutcome>((resolve) => {
    show({ order, description: opts.description, studentName, done: resolve });
  });
}

const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

/** Render once inside the fee page. It shows nothing until a simulated payment starts. */
export default function SimulatedCheckoutHost() {
  const [pending, setPending] = useState<PendingPayment | null>(null);
  const [processing, setProcessing] = useState(false);
  const payButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    openWindow = (p) => { setProcessing(false); setPending(p); };
    return () => { openWindow = null; };
  }, []);
  useEffect(() => { if (pending) payButton.current?.focus(); }, [pending]);

  const finish = (outcome: CheckoutOutcome) => {
    const p = pending;
    setPending(null);
    setProcessing(false);
    p?.done(outcome);
  };
  const cancel = () => {
    if (!pending || processing) return;
    void reportOutcome(pending.order.orderId, 'CANCELLED');
    finish({ kind: 'cancelled' });
  };
  const decline = () => {
    if (!pending || processing) return;
    void reportOutcome(pending.order.orderId, 'FAILED', 'Simulated payment declined');
    finish({ kind: 'failed', reason: 'the payment was declined' });
  };
  const pay = async () => {
    if (!pending || processing) return;
    setProcessing(true);
    try {
      await wait(PROCESSING_MS);
      const signed = await simulatePayment(pending.order.orderId);   // the server signs a test payment for this order
      const result = await verifyPayment(signed);                    // the same verification as real Razorpay payments
      finish({ kind: 'success', result });
    } catch (e) {
      finish({ kind: 'failed', reason: messageOf(e) });
    }
  };

  useEffect(() => {
    if (!pending) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!pending) return null;
  const amount = rupees.format(pending.order.amount / 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="sim-pay-title"
           className="w-full max-w-[420px] rounded-xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 id="sim-pay-title" className="m-0 text-[16px] font-semibold text-navy">Secure payment</h2>
          <span className="rounded-full border border-line bg-active px-2.5 py-0.5 text-[11px] font-medium text-navy">Test mode</span>
        </div>

        <div className="mt-5 rounded-lg border border-line bg-active p-4">
          <div className="text-[12.5px] text-muted">{pending.description}</div>
          <div className="mt-1 text-[28px] font-semibold tracking-tight text-navy">{amount}</div>
          {pending.studentName && <div className="mt-1 text-[12.5px] text-muted">Paying as {pending.studentName}</div>}
        </div>

        <p className="mb-0 mt-4 text-[12.5px] leading-5 text-muted">
          This is a simulated payment. No real money is charged and no card or bank details are collected.
        </p>

        <button ref={payButton} type="button" onClick={() => void pay()} disabled={processing}
                className="mt-5 h-[44px] w-full rounded-lg bg-navy text-[14px] font-semibold text-white disabled:opacity-70">
          {processing ? 'Processing payment…' : `Pay ${amount}`}
        </button>
        <div className="mt-3 flex items-center justify-between text-[12.5px]">
          <button type="button" onClick={cancel} disabled={processing} className="text-muted underline disabled:opacity-50">Cancel</button>
          <button type="button" onClick={decline} disabled={processing} className="text-muted underline disabled:opacity-50">Simulate a failed payment</button>
        </div>
      </div>
    </div>
  );
}
