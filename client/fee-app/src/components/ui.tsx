import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <section className={`rounded-[10px] border border-line bg-white ${className}`}>{children}</section>;
}

export function CardHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
      {right}
    </div>
  );
}

const TONES = {
  ok: 'bg-ok-bg text-ok', warn: 'bg-warn-bg text-warn-ink', err: 'bg-err-bg text-err-ink',
  info: 'bg-active text-navy',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded px-2.5 py-[3px] text-[12.5px] font-semibold ${TONES[tone]}`}>{children}</span>;
}

export function Button({ variant = 'primary', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'link' }) {
  const base = variant === 'primary'
    ? 'h-10 rounded-lg bg-navy px-[18px] font-semibold text-white hover:bg-navy-dark'
    : variant === 'secondary'
      ? 'h-10 rounded-lg border border-line bg-white px-4 font-medium hover:bg-page'
      : 'text-[13px] font-medium text-link hover:underline';
  return <button {...p} className={`${base} disabled:cursor-not-allowed disabled:opacity-60 ${className}`} />;
}

export function Notice({ tone, children, onDismiss }: { tone: Tone; children: ReactNode; onDismiss?: () => void }) {
  return (
    <div role="status" className={`flex items-center justify-between gap-3 rounded-lg px-4 py-3 font-medium ${TONES[tone]}`}>
      <span>{children}</span>
      {onDismiss && <button className="text-[13px] font-medium underline" onClick={onDismiss}>Dismiss</button>}
    </div>
  );
}

export function Modal({ label, onClose, children, maxWidth = 'max-w-[460px]' }: { label: string; onClose?: () => void; children: ReactNode; maxWidth?: string }) {
  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-navy-dark/55 p-4">
      <div role="dialog" aria-modal="true" aria-label={label} className={`w-full ${maxWidth} overflow-hidden rounded-xl bg-white`}>{children}</div>
    </div>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-px font-semibold">{value}</div>
    </div>
  );
}
