import { useState } from 'react';
import { Button, Modal } from '../ui';
import { inr } from '../../lib/format';

export const TOPUP_MIN = 1;
export const TOPUP_MAX = 100000; // UI limit only: the server must enforce its own limits

interface Props { balance: number; busy: boolean; error: string | null; onClose: () => void; onConfirm: (amount: number) => void }

export default function AddMoneyModal({ balance, busy, error, onClose, onConfirm }: Props) {
  const [text, setText] = useState('500');
  const amount = Math.round(Number(text) * 100) / 100;
  const valid = amount >= TOPUP_MIN && amount <= TOPUP_MAX;
  return (
    <Modal label="Add money to D-Wallet" onClose={busy ? undefined : onClose} maxWidth="max-w-[420px]">
      <div className="bg-navy-dark px-5 py-[18px] text-white">
        <div className="text-[13px] text-[#B9C6E3]">Current D-Wallet balance</div>
        <div className="text-2xl font-semibold">{inr(balance)}</div>
      </div>
      <div className="px-5 py-4">
        {error && <div className="mb-3 rounded-lg bg-err-bg px-3 py-2.5 font-medium text-err-ink">{error}</div>}
        <label htmlFor="topup" className="mb-1.5 block text-xs font-semibold text-muted">AMOUNT TO ADD (₹)</label>
        <input id="topup" inputMode="decimal" value={text} disabled={busy}
          onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ''))}
          className="box-border h-11 w-full rounded-lg border border-line px-3 text-lg font-semibold" />
        {!valid && text !== '' && <div className="mt-1 text-xs text-err-ink">Enter an amount between {inr(TOPUP_MIN)} and {inr(TOPUP_MAX)}.</div>}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {[500, 1000, 2000, 5000].map((v) => (
            <button key={v} disabled={busy} onClick={() => setText(String(v))}
              className={`h-9 rounded-lg border px-3 font-medium ${amount === v ? 'border-navy bg-active text-navy' : 'border-line bg-white'}`}>
              + ₹{v.toLocaleString('en-IN')}
            </button>
          ))}
        </div>
        <div className="mt-3 flex justify-between rounded-lg bg-soft px-3 py-2.5">
          <span className="text-xs text-muted">Balance after top-up</span>
          <span className="font-semibold">{inr(balance + (valid ? amount : 0))}</span>
        </div>
        <div className="mt-4 flex gap-2.5">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button className="flex-1" disabled={!valid || busy} onClick={() => onConfirm(amount)}>
            {busy ? 'Waiting for payment…' : `Pay ${valid ? inr(amount) : ''} on Razorpay`}
          </Button>
        </div>
        <div className="mt-2.5 text-xs text-muted">Your wallet is credited only after the payment is verified by our server.</div>
      </div>
    </Modal>
  );
}
