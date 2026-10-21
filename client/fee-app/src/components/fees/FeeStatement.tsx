import { Button, Card, CardHeader, Field } from '../ui';
import { StatusBadge } from './FeeSummaryCards';
import { fmtDateTime, inr, totals } from '../../lib/format';
import type { FeeStatement as Statement, Payment, Student } from '../../types';

interface Props {
  student: Student; statement: Statement; lastPayment?: Payment; busy: boolean;
  onPay: () => void; onViewReceipt: (id: string) => void;
}

export default function FeeStatement({ student, statement, lastPayment, busy, onPay, onViewReceipt }: Props) {
  const t = totals(statement);
  return (
    <Card className="min-w-0 flex-[3_1_560px]">
      <div className="border-b border-rule"><CardHeader title="Academic Fee Statement" right={<StatusBadge status={statement.status} />} /></div>
      <div className="px-5 py-[18px]">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-dashed border-[#B9C2D3] text-[11px] text-label">LOGO</div>
          <div>
            <div className="text-base font-semibold">Pune Institute of Computer Technology</div>
            <div className="text-xs text-muted">Fee statement · Academic year {statement.academicYear}</div>
          </div>
        </div>

        <div className="mt-[18px] grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-x-6 gap-y-3.5 rounded-lg bg-soft px-4 py-3.5">
          <Field label="Student name" value={student.name} />
          <Field label="Student no." value={student.studentNo} />
          <Field label="Admission no." value={student.admissionNo} />
          <Field label="Department" value={student.department} />
          <Field label="Course / program" value={student.program} />
          <Field label="Student category" value={student.category} />
        </div>

        <div className="mt-[18px] flex justify-between px-1 pb-2 text-xs font-semibold text-muted"><span>Fee component</span><span>Amount</span></div>
        {statement.components.map((c) => (
          <div key={c.id} className="flex justify-between border-t border-rule px-1 py-[11px]"><span>{c.name}</span><span>{inr(c.amount)}</span></div>
        ))}
        <div className="flex items-baseline justify-between border-t-2 border-ink px-1 pb-1 pt-3.5 font-semibold">
          <span className="text-[15px]">Total Academic Fee</span><span className="text-xl">{inr(t.total)}</span>
        </div>

        <div className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-6 gap-y-3 rounded-lg border border-rule px-4 py-3.5">
          <Field label="Paid to date" value={inr(t.paid)} />
          <Field label="Outstanding" value={<span className={t.outstanding > 0 ? 'text-warn-ink' : 'text-ok'}>{inr(t.outstanding)}</span>} />
          <div><div className="text-xs text-muted">Payment status</div><div className="mt-[3px]"><StatusBadge status={statement.status} /></div></div>
        </div>

        {statement.status === 'PENDING' && (
          <div className="mt-[18px] flex flex-wrap items-center gap-3">
            <Button onClick={onPay} disabled={busy}>{busy ? 'Opening payment…' : `Pay Fee · ${inr(t.outstanding)}`}</Button>
            <span className="text-xs text-muted">You will pay securely on Razorpay Checkout.</span>
          </div>
        )}
        {statement.status === 'PROCESSING' && (
          <div className="mt-[18px] rounded-lg bg-active px-4 py-3.5 text-navy">
            <div className="font-semibold">Payment Processing</div>
            <div className="mt-0.5 text-[13px]">We have not yet received confirmation from the bank. This page updates automatically once it is confirmed. Do not pay again.</div>
          </div>
        )}
        {statement.status === 'PAID' && (
          <>
            <div className="mt-[18px] rounded-lg bg-ok-bg px-4 py-3.5 text-ok">
              <div className="font-semibold">Paid Successfully</div>
              {lastPayment && <div className="mt-0.5 text-[13px]">Paid on {fmtDateTime(lastPayment.date)} · Ref {lastPayment.referenceId}</div>}
            </div>
            {lastPayment && (
              <div className="mt-3.5 flex flex-wrap gap-3">
                <Button onClick={() => onViewReceipt(lastPayment.id)}>Download Fee Receipt</Button>
                <Button variant="secondary" onClick={() => onViewReceipt(lastPayment.id)}>Preview receipt</Button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
