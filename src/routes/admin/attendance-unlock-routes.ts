import { Router } from 'express';
import { z } from 'zod';
import { transaction } from '../../db.js';
import { HttpError } from '../../lib/http-error.js';
import { flash } from '../../middleware/auth.js';
import { decideAttendanceUnlock, getPendingAttendanceUnlocks } from '../../queries/attendance-unlock-queries.js';

export const attendanceUnlockAdminRouter = Router();

function requestId(value: string | undefined): number {
  const parsed = z.coerce.number().int().positive().safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'Attendance unlock request ID must be a positive integer.');
  return parsed.data;
}

attendanceUnlockAdminRouter.get('/attendance-unlocks', async (_req, res) => {
  res.render('admin/attendance-unlocks', {
    title: 'Attendance unlocks', nav: 'attendance-unlocks', requests: await getPendingAttendanceUnlocks(),
  });
});

for (const decision of ['approved', 'rejected'] as const) {
  attendanceUnlockAdminRouter.post(`/attendance-unlocks/:id/${decision}`, async (req, res) => {
    const id = requestId(req.params.id);
    try {
      await transaction((db) => decideAttendanceUnlock(db, id, req.user!.userId, decision));
      flash(req, 'success', `Attendance unlock request ${decision}.`);
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) {
        flash(req, 'error', error.message);
      } else {
        throw error;
      }
    }
    res.redirect('/admin/attendance-unlocks');
  });
}
