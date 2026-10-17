/** Display helpers, exposed to every view as `fmt`. All times are shown in college time (IST). */
const TZ = 'Asia/Kolkata';
const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
const shortDateFmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ,
});

/** 'YYYY-MM-DD' strings are calendar dates: parse them at noon UTC so no timezone shifts the day. */
function toDate(value: string | Date): Date {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
}

export const fmt = {
  date: (v: string | Date | null | undefined): string => (v ? dateFmt.format(toDate(v)) : '–'),
  shortDate: (v: string | Date | null | undefined): string => (v ? shortDateFmt.format(toDate(v)) : '–'),
  dateTime: (v: string | Date | null | undefined): string => (v ? dateTimeFmt.format(new Date(v)) : '–'),
  pct: (v: number | null | undefined, digits = 0): string => (v === null || v === undefined ? '–' : `${v.toFixed(digits)}%`),
  num: (v: number | null | undefined): string => (v === null || v === undefined ? '–' : v.toLocaleString('en-IN')),
  credits: (v: number): string => v.toFixed(1),
  time: (v: string | null | undefined): string => {
    if (!v) return '–';
    const [h = 0, m = 0] = v.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? ' AM' : ' PM'}`;
  },
  day: (n: number): string => DAY_NAMES[n] ?? '',
  roman: (n: number): string => ROMAN[n] ?? String(n),
  initials: (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join(''),
  ltp: (l: number, t: number, p: number): string => `${l}-${t}-${p}`,
};

/** Today's date in IST as 'YYYY-MM-DD'. */
export function todayIso(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a 'YYYY-MM-DD' date. */
export function isoWeekday(isoDate: string): number {
  const d = toDate(isoDate).getUTCDay();
  return d === 0 ? 7 : d;
}

export function addDays(isoDate: string, days: number): string {
  const d = toDate(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface TermProgress { pct: number; week: number; totalWeeks: number; daysLeft: number; }

export function termProgress(start: string, end: string, today = todayIso()): TermProgress {
  const ms = (a: string, b: string): number => toDate(b).getTime() - toDate(a).getTime();
  const day = 86_400_000;
  const total = Math.max(1, Math.round(ms(start, end) / day));
  const elapsed = Math.min(total, Math.max(0, Math.round(ms(start, today) / day)));
  return {
    pct: Math.round((100 * elapsed) / total),
    week: Math.min(Math.ceil(total / 7), Math.floor(elapsed / 7) + 1),
    totalWeeks: Math.ceil(total / 7),
    daysLeft: total - elapsed,
  };
}
