import { Badge, Button, Card, CardHeader, type Tone } from '../ui';
import { fmtDate, inr } from '../../lib/format';
import type { Payment } from '../../types';

const TONE: Record<Payment['status'], Tone> = { SUCCESS: 'ok', FAILED: 'err', CANCELLED: 'warn', PENDING: 'info' };
const LABEL: Record<Payment['status'], string> = { SUCCESS: 'Success', FAILED: 'Failed', CANCELLED: 'Cancelled', PENDING: 'Pending' };
const COLS = 'grid min-w-[900px] grid-cols-[110px_100px_1.4fr_1.2fr_100px_110px_90px_90px] items-center gap-2.5 px-3.5 py-3 text-[13.5px]';

export default function PaymentHistory({ payments, onViewReceipt }: { payments: Payment[]; onViewReceipt: (id: string) => void }) {
  return (
    <Card>
      <CardHeader title="Payment History" />
      <div className="overflow-x-auto">
        <div className={`${COLS} border-t border-rule bg-soft text-xs font-semibold text-muted`}>
          <span>Date</span><span>Academic year</span><span>Fee description</span><span>Reference ID</span><span>Method</span><span>Amount</span><span>Status</span><span>Receipt</span>
        </div>
        {payments.map((p) => (
          <div key={p.id} className={`${COLS} border-t border-rule`}>
            <span className="text-muted">{fmtDate(p.date)}</span>
            <span>{p.academicYear}</span>
            <span className="font-medium">{p.description}</span>
            <span className="truncate text-muted" title={p.referenceId}>{p.referenceId}</span>
            <span>{p.method}</span>
            <span className="font-semibold">{inr(p.amount)}</span>
            <span><Badge tone={TONE[p.status]}>{LABEL[p.status]}</Badge></span>
            <span>{p.status === 'SUCCESS' && <Button variant="link" onClick={() => onViewReceipt(p.id)}>View</Button>}</span>
          </div>
        ))}
      </div>
      {payments.length === 0 && (
        <div className="border-t border-rule px-4 py-6 text-muted">No payment attempts yet. Failed and cancelled attempts appear here but are never counted as paid.</div>
      )}
    </Card>
  );
}
