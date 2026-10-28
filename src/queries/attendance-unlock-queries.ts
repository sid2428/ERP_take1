import { UNLOCK_HOURS } from '../lib/attendance-lock.js';
import { query, queryOne, type Db } from '../db.js';
import { HttpError, notFound } from '../lib/http-error.js';
import { isAttendanceSessionLocked } from '../lib/attendance-lock.js';

export function getActiveAttendanceUnlock(db: Db, sessionId: number) {
  return queryOne<{ request_id: number; unlock_expires_at: Date }>(`
    SELECT request_id, unlock_expires_at
    FROM attendance_unlock_request
    WHERE session_id = $1 AND status = 'approved' AND unlock_expires_at > now()
    ORDER BY decided_at DESC LIMIT 1`, [sessionId], db);
}

export async function getPendingAttendanceUnlocks() {
  return query<{
    request_id: number;
    session_id: number;
    session_date: string;
    course_code: string;
    class_label: string;
    faculty_name: string;
    requested_by: number;
    requester_login: string;
    reason: string;
    created_at: Date;
  }>(`
    SELECT r.request_id, s.session_id, s.session_date, c.course_code,
           COALESCE(d.division_code, o.section_name, c.course_code || ' offering') AS class_label,
           f.first_name || ' ' || f.last_name AS faculty_name,
           r.requested_by, u.login_id AS requester_login, r.reason, r.created_at
    FROM attendance_unlock_request r
    JOIN attendance_session s USING (session_id)
    JOIN teaching_assignment ta USING (assignment_id)
    JOIN course c USING (course_id)
    JOIN app_user u ON u.user_id = r.requested_by
    JOIN faculty f ON f.faculty_id = u.faculty_id
    LEFT JOIN division d ON d.division_id = ta.division_id
    LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at, r.request_id`);
}

export async function requestFacultyAttendanceUnlock(
  db: Db, facultyId: number, userId: number, assignmentId: number, sessionId: number, reason: string,
): Promise<{ request_id: number; status: 'pending' }> {
  const session = await queryOne<{ session_date: string; session_id: number }>(`
    SELECT s.session_id, s.session_date
    FROM attendance_session s
    JOIN teaching_assignment ta USING (assignment_id)
    WHERE s.session_id = $1 AND ta.assignment_id = $2 AND ta.faculty_id = $3
      AND ta.academic_session_id = current_session_id()
      AND EXISTS (
        SELECT 1 FROM app_user u
        WHERE u.user_id = $4 AND u.role = 'faculty' AND u.faculty_id = $3 AND u.is_active
      )
    FOR UPDATE OF s`, [sessionId, assignmentId, facultyId, userId], db);
  if (!session) throw notFound('Attendance session');
  if (!isAttendanceSessionLocked(session.session_date, null)) {
    throw new HttpError(400, 'This attendance session is not currently locked.');
  }
  if (await getActiveAttendanceUnlock(db, sessionId)) {
    throw new HttpError(400, 'This attendance session is already unlocked.');
  }
  const pending = await queryOne<{ request_id: number }>(`
    SELECT request_id FROM attendance_unlock_request
    WHERE session_id = $1 AND status = 'pending'`, [sessionId], db);
  if (pending) throw new HttpError(409, 'An unlock request is already pending for this session.');
  const saved = await queryOne<{ request_id: number }>(`
    INSERT INTO attendance_unlock_request (session_id, requested_by, reason)
    VALUES ($1, $2, $3) RETURNING request_id`, [sessionId, userId, reason], db);
  if (!saved) throw new Error('Attendance unlock request was not saved.');
  return { request_id: saved.request_id, status: 'pending' };
}

export async function decideAttendanceUnlock(
  db: Db, requestId: number, adminUserId: number, decision: 'approved' | 'rejected',
): Promise<{ request_id: number; status: 'approved' | 'rejected'; unlock_expires_at: Date | null }> {
  const admin = await queryOne<{ user_id: number }>(`
    SELECT user_id FROM app_user WHERE user_id = $1 AND role = 'admin' AND is_active`, [adminUserId], db);
  if (!admin) throw new HttpError(403, 'Only an active admin can decide an attendance unlock request.');
  const request = await queryOne<{
    request_id: number;
    session_id: number;
    requested_by: number;
    status: string;
  }>(`SELECT request_id, session_id, requested_by, status
      FROM attendance_unlock_request WHERE request_id = $1 FOR UPDATE`, [requestId], db);
  if (!request) throw notFound('Attendance unlock request');
  if (request.requested_by === adminUserId) {
    throw new HttpError(403, 'You cannot decide your own attendance unlock request.');
  }
  if (request.status !== 'pending') throw new HttpError(409, 'This attendance unlock request has already been decided.');

  const saved = await queryOne<{
    request_id: number;
    session_id: number;
    status: 'approved' | 'rejected';
    unlock_expires_at: Date | null;
  }>(`
    UPDATE attendance_unlock_request
    SET status = $2, decided_by = $3, decided_at = now(),
        unlock_expires_at = CASE WHEN $2 = 'approved'
          THEN now() + make_interval(hours => $4) ELSE NULL END
    WHERE request_id = $1
    RETURNING request_id, session_id, status, unlock_expires_at`,
  [requestId, decision, adminUserId, UNLOCK_HOURS], db);
  if (!saved) throw new Error('Attendance unlock decision was not saved.');
  await db.query(`
    INSERT INTO attendance_session_audit
      (session_id, request_id, actor_id, action, old_value, new_value)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
  [
    saved.session_id, requestId, adminUserId,
    decision === 'approved' ? 'unlock_approved' : 'unlock_rejected',
    JSON.stringify({ status: request.status }),
    JSON.stringify({ status: decision, unlock_expires_at: saved.unlock_expires_at }),
  ]);
  return saved;
}
