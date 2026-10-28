import { todayIso } from './format.js';

export const LOCK_DAYS = 14;
export const UNLOCK_HOURS = 48;

export function attendanceLockCutoff(today = todayIso()): string {
  const [year, month, day] = today.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - LOCK_DAYS)).toISOString().slice(0, 10);
}

export function isAttendanceSessionLocked(
  sessionDate: string, expiresAt: Date | string | null, today = todayIso(), now = new Date(),
): boolean {
  return sessionDate < attendanceLockCutoff(today) && (!expiresAt || new Date(expiresAt).getTime() <= now.getTime());
}
