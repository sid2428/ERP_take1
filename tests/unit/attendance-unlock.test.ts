import { describe, expect, it } from 'vitest';
import { attendanceLockCutoff, isAttendanceSessionLocked } from '../../src/lib/attendance-lock.js';

describe('attendance unlock window', () => {
  it('uses the Asia/Kolkata calendar date and locks day 15, not day 14', () => {
    const today = '2026-10-23';
    expect(attendanceLockCutoff(today)).toBe('2026-10-09');
    expect(isAttendanceSessionLocked('2026-10-09', null, today)).toBe(false);
    expect(isAttendanceSessionLocked('2026-10-08', null, today)).toBe(true);
  });

  it('treats an expired unlock as locked and a live unlock as editable', () => {
    const today = '2026-10-23';
    const now = new Date('2026-10-23T12:00:00Z');
    expect(isAttendanceSessionLocked('2026-10-08', '2026-10-23T11:59:59Z', today, now)).toBe(true);
    expect(isAttendanceSessionLocked('2026-10-08', '2026-10-23T12:00:01Z', today, now)).toBe(false);
  });
});
