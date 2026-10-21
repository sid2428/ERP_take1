import type { FeeStatement } from '../types';

export const inr = (n: number) =>
  '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export const fmtDateTime = (iso: string) =>
  fmtDate(iso) + ', ' + new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

/** Total is always computed from the components; outstanding = total - verified payments. */
export function totals(s: FeeStatement) {
  const total = s.components.reduce((sum, c) => sum + c.amount, 0);
  const outstanding = Math.max(total - s.amountPaid, 0);
  return { total, paid: s.amountPaid, outstanding };
}
