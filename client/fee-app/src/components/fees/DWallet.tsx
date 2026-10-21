import { useState } from 'react';
import { Badge, Button, Card, CardHeader } from '../ui';
import { fmtDate, inr } from '../../lib/format';
import type { Wallet } from '../../types';

export default function DWallet({ wallet, onAddMoney }: { wallet: Wallet; onAddMoney: () => void }) {
  const [all, setAll] = useState(false);
  const txs = all ? wallet.transactions : wallet.transactions.slice(0, 4);
  return (
    <Card className="min-w-0 flex-[2_1_320px]">
      <CardHeader title="D-Wallet" right={<Badge tone="info">Campus wallet</Badge>} />
      <div className="px-4 pb-3.5">
        <div className="text-xs text-muted">Current wallet balance</div>
        <div className="text-[28px] font-semibold tracking-tight">{inr(wallet.balance)}</div>
        <div className="mt-0.5 text-xs text-muted">Kept separate from academic fee dues.</div>
        <Button className="mt-3 !h-9" onClick={onAddMoney}>Add Money</Button>
      </div>
      <div className="px-4 pb-1.5">
        <div className="py-2 text-xs font-semibold text-muted">Recent transactions</div>
        {txs.length === 0 && <div className="border-t border-rule py-3 text-muted">No transactions yet.</div>}
        {txs.map((t) => (
          <div key={t.id} className="flex justify-between gap-3 border-t border-rule py-2.5">
            <div className="min-w-0">
              <div className="font-medium">{t.description}</div>
              <div className="text-xs text-muted">{fmtDate(t.date)} · {t.status[0] + t.status.slice(1).toLowerCase()}</div>
            </div>
            <div className={`whitespace-nowrap font-semibold ${t.type === 'CREDIT' ? 'text-ok' : ''}`}>{t.type === 'CREDIT' ? '+ ' : '− '}{inr(t.amount)}</div>
          </div>
        ))}
      </div>
      {wallet.transactions.length > 4 && (
        <div className="px-4 pb-4 pt-2"><Button variant="link" onClick={() => setAll(!all)}>{all ? 'Show fewer' : 'View All Transactions'}</Button></div>
      )}
    </Card>
  );
}
