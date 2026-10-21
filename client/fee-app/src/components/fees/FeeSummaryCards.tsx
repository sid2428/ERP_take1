import Icon from '../Icon';
import { Badge, Card } from '../ui';
import { inr, totals } from '../../lib/format';
import type { FeeStatement, Wallet } from '../../types';

export default function FeeSummaryCards({ statement, wallet }: { statement: FeeStatement; wallet: Wallet }) {
  const t = totals(statement);
  const cards = [
    { label: 'Total Academic Fee', icon: 'receipt', color: 'text-muted', value: inr(t.total), foot: <span className="text-[12.5px] text-muted">Academic year {statement.academicYear}</span> },
    { label: 'Amount Paid', icon: 'check', color: 'text-ok', value: inr(t.paid), foot: <Badge tone={t.paid > 0 ? 'ok' : 'warn'}>{t.paid > 0 ? 'Payment received' : 'No payment yet'}</Badge> },
    { label: 'Outstanding Balance', icon: 'clock', color: 'text-amber', value: inr(t.outstanding), foot: <StatusBadge status={statement.status} /> },
    { label: 'D-Wallet Balance', icon: 'wallet', color: 'text-navy', value: inr(wallet.balance), foot: <span className="text-[12.5px] text-muted">Separate from fee dues</span> },
  ];
  return (
    <section className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-5">
      {cards.map((c) => (
        <Card key={c.label} className="p-4">
          <div className="flex items-center gap-2 text-[13px] text-muted"><Icon name={c.icon} className={c.color} />{c.label}</div>
          <div className="mt-2 text-2xl font-semibold tracking-tight">{c.value}</div>
          <div className="mt-1.5">{c.foot}</div>
        </Card>
      ))}
    </section>
  );
}

export function StatusBadge({ status }: { status: FeeStatement['status'] }) {
  if (status === 'PAID') return <Badge tone="ok">Paid Successfully</Badge>;
  if (status === 'PROCESSING') return <Badge tone="info">Payment Processing</Badge>;
  return <Badge tone="warn">Payment Pending</Badge>;
}
