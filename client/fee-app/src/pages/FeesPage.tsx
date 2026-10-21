import { useState } from 'react';
import AddMoneyModal from '../components/fees/AddMoneyModal';
import DWallet from '../components/fees/DWallet';
import FeeReceipt from '../components/fees/FeeReceipt';
import FeeStatement from '../components/fees/FeeStatement';
import FeeSummaryCards from '../components/fees/FeeSummaryCards';
import PaymentHistory from '../components/fees/PaymentHistory';
import PaymentSuccess from '../components/fees/PaymentSuccess';
import { Button, Card, Notice, type Tone } from '../components/ui';
import { createFeeOrder, createTopupOrder } from '../lib/api';
import { totals } from '../lib/format';
import { runCheckout, type CheckoutOutcome } from '../lib/razorpay';
import { useStudent } from '../lib/student';
import { useFinance } from '../lib/useFinance';
import type { VerifyResult } from '../types';

type Tab = 'statement' | 'history';
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Please try again.');

export default function FeesPage() {
  const student = useStudent();
  const { statement, wallet, payments, loading, error, refresh } = useFinance();
  const [tab, setTab] = useState<Tab>('statement');
  const [busy, setBusy] = useState<null | 'fee' | 'topup'>(null);
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupError, setTopupError] = useState<string | null>(null);
  const [success, setSuccess] = useState<VerifyResult | null>(null);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  if (loading) return <Card className="p-6 text-muted">Loading your fee details…</Card>;
  if (error || !statement || !wallet) {
    return <Card className="flex items-center justify-between gap-3 p-6"><span className="text-err-ink">{error ?? 'Could not load fee details.'}</span><Button variant="secondary" onClick={() => void refresh()}>Retry</Button></Card>;
  }

  const prefill = { name: student.name, email: student.email, contact: student.phone };
  const lastPaid = payments.find((p) => p.status === 'SUCCESS');
  const receiptPayment = payments.find((p) => p.id === receiptId);

  /** One place decides what each Razorpay outcome means for the page. */
  async function handleOutcome(o: CheckoutOutcome, kind: 'fee' | 'topup') {
    if (o.kind === 'success') {
      await refresh(); // numbers come from the server, never computed locally
      setTopupOpen(false); setTopupError(null); setSuccess(o.result);
      return;
    }
    const msg =
      o.kind === 'failed' ? `Payment failed: ${o.reason}. No amount was added or marked paid. You can try again.`
      : o.kind === 'cancelled' ? 'Payment cancelled. Nothing was charged and your balances are unchanged.'
      : 'We received your payment but are still waiting for bank confirmation. Please do not pay again; this page updates once it is confirmed.';
    if (kind === 'topup' && o.kind !== 'processing') setTopupError(msg);
    else { setTopupOpen(false); setNotice({ tone: o.kind === 'failed' ? 'err' : o.kind === 'cancelled' ? 'warn' : 'info', text: msg }); }
    await refresh();
  }

  async function pay(kind: 'fee' | 'topup', createOrder: () => ReturnType<typeof createFeeOrder>, description: string) {
    setBusy(kind); setNotice(null); setTopupError(null);
    try {
      await handleOutcome(await runCheckout({ createOrder, description, prefill }), kind);
    } catch (e) {
      if (kind === 'topup') setTopupError(errText(e)); else setNotice({ tone: 'err', text: errText(e) });
    } finally { setBusy(null); }
  }

  const tabBtn = (id: Tab, label: string) => (
    <button onClick={() => setTab(id)} className={`-mb-px h-[42px] border-b-2 px-4 ${tab === id ? 'border-navy font-semibold text-navy' : 'border-transparent font-medium text-muted'}`}>{label}</button>
  );

  return (
    <>
      <div>
        <div className="text-[12.5px] text-muted">Dashboard / Finance / Fee Structure &amp; D-Wallet</div>
        <h1 className="mb-0 mt-1.5 text-[22px] font-semibold tracking-tight">Fee Structure &amp; D-Wallet</h1>
        <div className="mt-0.5 text-muted">View your academic fee details, manage outstanding dues, and access your payment receipts.</div>
      </div>

      {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}
      <FeeSummaryCards statement={statement} wallet={wallet} />

      <div className="flex gap-1 border-b border-line">{tabBtn('statement', 'Fee statement')}{tabBtn('history', 'Payment history')}</div>

      {tab === 'statement' ? (
        <div className="flex flex-wrap items-start gap-5">
          <FeeStatement student={student} statement={statement} lastPayment={lastPaid} busy={busy === 'fee'}
            onPay={() => void pay('fee', createFeeOrder, `Academic fee ${statement.academicYear}`)}
            onViewReceipt={setReceiptId} />
          <DWallet wallet={wallet} onAddMoney={() => { setTopupError(null); setTopupOpen(true); }} />
        </div>
      ) : (
        <PaymentHistory payments={payments} onViewReceipt={setReceiptId} />
      )}

      {topupOpen && (
        <AddMoneyModal balance={wallet.balance} busy={busy === 'topup'} error={topupError}
          onClose={() => setTopupOpen(false)}
          onConfirm={(amount) => void pay('topup', () => createTopupOrder(amount), 'D-Wallet top-up')} />
      )}
      {success && (
        <PaymentSuccess student={student} result={success} outstanding={totals(statement).outstanding} walletBalance={wallet.balance}
          onReceipt={() => { setReceiptId(success.paymentId); setSuccess(null); }} onClose={() => setSuccess(null)} />
      )}
      {receiptPayment && <FeeReceipt student={student} statement={statement} payment={receiptPayment} onClose={() => setReceiptId(null)} />}
    </>
  );
}
