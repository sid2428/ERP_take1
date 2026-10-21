import { Button, Modal } from '../ui';
import Icon from '../Icon';
import { fmtDateTime, inr } from '../../lib/format';
import type { Student, VerifyResult } from '../../types';

interface Props {
  student: Student; result: VerifyResult;
  outstanding: number; walletBalance: number;
  onReceipt: () => void; onClose: () => void;
}

export default function PaymentSuccess({ student, result, outstanding, walletBalance, onReceipt, onClose }: Props) {
  const isFee = result.purpose === 'FEE';
  const rows: [string, string][] = [
    ['Student', student.name], ['Student no.', student.studentNo],
    [isFee ? 'Amount paid' : 'Amount added', inr(result.amount)],
    isFee ? ['Remaining outstanding', inr(outstanding)] : ['New wallet balance', inr(walletBalance)],
    ['Date & time', fmtDateTime(result.paidAt)], ['Reference ID', result.referenceId], ['Payment method', result.method],
  ];
  return (
    <Modal label="Payment successful" onClose={onClose}>
      <div className="p-6">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-ok-bg text-ok"><Icon name="tick" size={24} /></div>
        <h2 className="mb-0 mt-3 text-center text-xl font-semibold">Payment Successful</h2>
        <div className="mt-1 text-center text-muted">{isFee ? 'Your academic fee payment has been recorded.' : 'Money has been added to your D-Wallet.'}</div>
        <div className="mt-4 rounded-lg border border-rule px-3.5 py-1">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-t border-rule py-[9px] first:border-t-0">
              <span className="text-xs text-muted">{k}</span><span className="text-right font-semibold">{v}</span>
            </div>
          ))}
        </div>
        {result.isTest && <div className="mt-3 rounded-md bg-warn-bg px-3 py-2 text-[12.5px] text-warn-ink">Razorpay Test Mode: this was a test payment, no real money was charged.</div>}
        <div className="mt-4 flex flex-wrap gap-2.5">
          {isFee && <Button onClick={onReceipt}>Download Fee Receipt</Button>}
          <Button variant="secondary" onClick={onClose}>Back to Fee Structure</Button>
        </div>
      </div>
    </Modal>
  );
}
