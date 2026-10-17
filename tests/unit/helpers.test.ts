import { describe, expect, it } from 'vitest';
import { addDays, fmt, isoWeekday, termProgress } from '../../src/lib/format.js';
import { pageInfo, parsePage, withQuery } from '../../src/lib/pagination.js';
import { tokensMatch } from '../../src/middleware/csrf.js';
import { nextClassDay } from '../../src/queries/shared-queries.js';

describe('date helpers', () => {
  it('finds ISO weekdays for calendar dates', () => {
    expect(isoWeekday('2026-10-16')).toBe(5);   // Friday
    expect(isoWeekday('2026-10-18')).toBe(7);   // Sunday
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('reports term progress', () => {
    const p = termProgress('2026-07-01', '2026-11-30', '2026-10-17');
    expect(p.pct).toBe(71);
    expect(p.daysLeft).toBe(44);
    expect(termProgress('2026-07-01', '2026-11-30', '2027-01-01').pct).toBe(100);
    expect(termProgress('2026-07-01', '2026-11-30', '2026-06-01').pct).toBe(0);
  });

  it('formats times, percentages and dates for display', () => {
    expect(fmt.time('09:00:00')).toBe('9:00 AM');
    expect(fmt.time('15:30:00')).toBe('3:30 PM');
    expect(fmt.pct(null)).toBe('–');
    expect(fmt.pct(79.04, 1)).toBe('79.0%');
    expect(fmt.date('2026-08-03')).toBe('3 Aug 2026');
    expect(fmt.initials('Aishani Caleb Sharaf')).toBe('AC');
  });
});

describe('nextClassDay', () => {
  const rows = [{ day_of_week: 1 }, { day_of_week: 3 }, { day_of_week: 3 }];
  it('uses today when there are classes today', () => {
    expect(nextClassDay(rows, 3)).toMatchObject({ offset: 0, day: 3 });
  });
  it('rolls over the weekend to Monday', () => {
    expect(nextClassDay(rows, 6)).toMatchObject({ offset: 2, day: 1 });
  });
  it('returns null with no classes at all', () => {
    expect(nextClassDay([], 2)).toBeNull();
  });
});

describe('pagination', () => {
  it('parses and clamps page numbers', () => {
    expect(parsePage('3')).toMatchObject({ page: 3, offset: 50 });
    expect(parsePage('-1').page).toBe(1);
    expect(parsePage('abc').page).toBe(1);
  });
  it('describes the visible range', () => {
    expect(pageInfo(parsePage('2'), 60)).toEqual({ page: 2, pages: 3, total: 60, from: 26, to: 50 });
  });
  it('keeps filters in pager links and drops empty ones', () => {
    expect(withQuery({ q: 'data', dept: '' }, { page: 2 })).toBe('?q=data&page=2');
  });
});

describe('csrf tokens', () => {
  it('matches only identical tokens', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true);
    expect(tokensMatch('abc', 'abd')).toBe(false);
    expect(tokensMatch('abc', undefined)).toBe(false);
    expect(tokensMatch(undefined, 'abc')).toBe(false);
  });
});
