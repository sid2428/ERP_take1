import { query, queryOne, type Db } from '../db.js';
import { ATTENDANCE_WEEKEND_DAYS } from '../config.js';
import { attendanceLockCutoff, isAttendanceSessionLocked } from '../lib/attendance-lock.js';
import { HttpError, notFound } from '../lib/http-error.js';
import { getActiveAttendanceUnlock } from './attendance-unlock-queries.js';

export interface FacultyAttendanceAssignment {
  assignment_id: number;
  course_id: number;
  course_code: string;
  course_name: string;
  session_type: string;
  division_id: number | null;
  division_code: string | null;
  batch_id: number | null;
  batch_code: string | null;
  class_label: string;
  students: number;
  term_start: string;
  term_end: string;
}

export interface FacultyAttendanceCalendar {
  term_start: string;
  term_end: string;
  today: string;
  allowed_weekdays: number[];
  weekend_days: readonly number[];
  has_timetable: boolean;
}

export function getFacultyAttendanceAssignments(facultyId: number): Promise<FacultyAttendanceAssignment[]> {
  return query<FacultyAttendanceAssignment>(`
    SELECT ta.assignment_id, c.course_id, c.course_code, c.course_name, ta.session_type,
           d.division_id, d.division_code, b.batch_id, b.batch_code,
           COALESCE(d.division_code, o.section_name, c.course_code || ' offering') AS class_label,
           (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = ta.assignment_id) AS students,
           s.start_date AS term_start, s.end_date AS term_end
    FROM teaching_assignment ta
    JOIN academic_session s ON s.session_id = ta.academic_session_id
    JOIN course c USING (course_id)
    LEFT JOIN division d ON d.division_id = ta.division_id
    LEFT JOIN batch b ON b.batch_id = ta.batch_id
    LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
    WHERE ta.faculty_id = $1 AND ta.academic_session_id = current_session_id()
    ORDER BY c.course_code, class_label, b.batch_code`, [facultyId]);
}

export async function getFacultyAttendanceCalendar(
  facultyId: number, assignmentId: number,
): Promise<FacultyAttendanceCalendar> {
  const calendar = await queryOne<{
    term_start: string;
    term_end: string;
    today: string;
    scheduled_weekdays: number[];
    has_timetable: boolean;
  }>(`
    SELECT s.start_date AS term_start, s.end_date AS term_end, current_date::text AS today,
           COALESCE(array_agg(DISTINCT te.day_of_week)
             FILTER (WHERE te.entry_id IS NOT NULL), '{}')::int[] AS scheduled_weekdays,
           count(te.entry_id) > 0 AS has_timetable
    FROM teaching_assignment ta
    JOIN academic_session s ON s.session_id = ta.academic_session_id
    LEFT JOIN timetable_entry te ON te.assignment_id = ta.assignment_id
    WHERE ta.assignment_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()
    GROUP BY s.start_date, s.end_date`, [assignmentId, facultyId]);
  if (!calendar) throw notFound('Teaching assignment');
  const weekdays = calendar.has_timetable
    ? calendar.scheduled_weekdays
    : [1, 2, 3, 4, 5, 6, 7];
  return {
    term_start: calendar.term_start,
    term_end: calendar.term_end,
    today: calendar.today,
    allowed_weekdays: weekdays.filter((day) => !ATTENDANCE_WEEKEND_DAYS.includes(day as 6 | 7)),
    weekend_days: ATTENDANCE_WEEKEND_DAYS,
    has_timetable: calendar.has_timetable,
  };
}

export async function getFacultyAttendanceRoster(
  facultyId: number, assignmentId: number, date: string, requestedSessionId?: number,
): Promise<{
  assignment: FacultyAttendanceAssignment;
  session_id: number | null;
  is_locked: boolean;
  unlock_status: 'pending' | 'approved' | 'rejected' | null;
  unlock_expires_at: Date | null;
  students: Array<{ student_id: number; student_number: string; name: string; roll_no: number | null; batch_code: string | null; status: string }>;
}> {
  const assignment = await queryOne<FacultyAttendanceAssignment>(`
    SELECT ta.assignment_id, c.course_id, c.course_code, c.course_name, ta.session_type,
           d.division_id, d.division_code, b.batch_id, b.batch_code,
           COALESCE(d.division_code, o.section_name, c.course_code || ' offering') AS class_label,
           (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = ta.assignment_id) AS students,
           s.start_date AS term_start, s.end_date AS term_end
    FROM teaching_assignment ta
    JOIN academic_session s ON s.session_id = ta.academic_session_id
    JOIN course c USING (course_id)
    LEFT JOIN division d ON d.division_id = ta.division_id
    LEFT JOIN batch b ON b.batch_id = ta.batch_id
    LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
    WHERE ta.assignment_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()`, [assignmentId, facultyId]);
  if (!assignment) throw notFound('Teaching assignment');
  if (date < assignment.term_start || date > assignment.term_end) {
    throw new HttpError(400, 'Attendance date must be within the academic session.');
  }

  const session = await queryOne<{
    session_id: number; session_date: string; absent_student_ids: number[];
    unlock_status: 'pending' | 'approved' | 'rejected' | null;
    unlock_expires_at: Date | null;
  }>(`
    SELECT s.session_id, s.session_date, s.absent_student_ids, r.status AS unlock_status, r.unlock_expires_at
    FROM attendance_session s
    JOIN teaching_assignment ta USING (assignment_id)
    LEFT JOIN LATERAL (
      SELECT status, unlock_expires_at FROM attendance_unlock_request
      WHERE session_id = s.session_id ORDER BY created_at DESC, request_id DESC LIMIT 1
    ) r ON true
    WHERE s.assignment_id = $1 AND s.session_date = $2 AND s.session_status = 'Conducted'
      AND (($3::int IS NULL AND s.is_extra = false) OR s.session_id = $3)
      AND ta.faculty_id = $4 AND ta.academic_session_id = current_session_id()`,
  [assignmentId, date, requestedSessionId ?? null, facultyId]);
  if (requestedSessionId !== undefined && !session) throw notFound('Attendance session');
  const students = await query<{
    student_id: number;
    student_number: string;
    name: string;
    roll_no: number | null;
    batch_code: string | null;
    status: string;
  }>(`
    SELECT s.student_id, s.student_number, s.first_name || ' ' || s.last_name AS name,
           ss.roll_no, b.batch_code,
           CASE WHEN $2::int[] @> ARRAY[s.student_id] THEN 'A' ELSE 'P' END AS status
    FROM v_assignment_roster r
    JOIN student s USING (student_id)
    JOIN teaching_assignment ta USING (assignment_id)
    LEFT JOIN student_section ss
      ON ss.student_id = s.student_id AND ss.academic_session_id = ta.academic_session_id
    LEFT JOIN batch b ON b.batch_id = ss.batch_id
    WHERE r.assignment_id = $1
    ORDER BY ss.roll_no NULLS LAST, s.student_number`,
  [assignmentId, session?.absent_student_ids ?? []]);

  return {
    assignment,
    session_id: session?.session_id ?? null,
    is_locked: session ? isAttendanceSessionLocked(session.session_date, session.unlock_expires_at) : false,
    unlock_status: session?.unlock_status ?? null,
    unlock_expires_at: session?.unlock_expires_at ?? null,
    students,
  };
}

export async function getFacultyAttendanceSessions(facultyId: number, assignmentId: number) {
  const sessions = await query<{
    session_id: number;
    session_date: string;
    session_number: number;
    session_status: string;
    present_count: number;
    absent_count: number;
    marked_at: string | null;
    is_extra: boolean;
    reason: string | null;
    latest_request_id: number | null;
    unlock_status: 'pending' | 'approved' | 'rejected' | null;
    unlock_expires_at: Date | null;
  }>(`
    SELECT s.session_id, s.session_date, s.session_number, s.session_status,
           (SELECT count(*)::int FROM v_assignment_roster r WHERE r.assignment_id = s.assignment_id)
             - cardinality(s.absent_student_ids) AS present_count,
           cardinality(s.absent_student_ids) AS absent_count, s.marked_at,
           s.is_extra, s.reason, r.request_id AS latest_request_id,
           r.status AS unlock_status, r.unlock_expires_at
    FROM attendance_session s
    JOIN teaching_assignment ta USING (assignment_id)
    LEFT JOIN LATERAL (
      SELECT request_id, status, unlock_expires_at
      FROM attendance_unlock_request WHERE session_id = s.session_id
      ORDER BY created_at DESC, request_id DESC LIMIT 1
    ) r ON true
    WHERE ta.assignment_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()
    ORDER BY s.session_date DESC, s.session_id DESC`, [assignmentId, facultyId]);
  return sessions.map((session) => ({
    ...session,
    is_locked: isAttendanceSessionLocked(session.session_date, session.unlock_expires_at),
  }));
}

export async function saveFacultyAttendance(
  db: Db,
  facultyId: number,
  assignmentId: number,
  date: string,
  absentStudentIds: number[],
  requestedSessionId?: number,
): Promise<{ session_id: number; session_number: number; created: boolean }> {
  await db.query('SELECT pg_advisory_xact_lock($1::integer)', [assignmentId]);
  const assignment = await queryOne<{ session_type: string; term_start: string; term_end: string }>(`
    SELECT ta.session_type, s.start_date AS term_start, s.end_date AS term_end
    FROM teaching_assignment ta
    JOIN academic_session s ON s.session_id = ta.academic_session_id
    WHERE ta.assignment_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()`, [assignmentId, facultyId], db);
  if (!assignment) throw notFound('Teaching assignment');
  if (date < assignment.term_start || date > assignment.term_end) {
    throw new HttpError(400, 'Attendance date must be within the academic session.');
  }
  const existing = await queryOne<{
    session_id: number; session_number: number; absent_student_ids: number[]; session_status: string;
    is_extra: boolean; reason: string | null;
  }>(`
    SELECT session_id, session_number, absent_student_ids, session_status, is_extra, reason
    FROM attendance_session
    WHERE assignment_id = $1 AND session_date = $2
      AND (($3::int IS NULL AND is_extra = false) OR session_id = $3)
    FOR UPDATE`, [assignmentId, date, requestedSessionId ?? null], db);
  if (requestedSessionId !== undefined && !existing) throw notFound('Attendance session');
  let unlockRequestId: number | null = null;
  if (date < attendanceLockCutoff()) {
    if (!existing) throw new HttpError(403, 'Attendance sessions older than 14 days are locked. An existing session is required for an unlock request.');
    const unlock = await getActiveAttendanceUnlock(db, existing.session_id);
    if (!unlock) throw new HttpError(403, 'This attendance session is locked. Request an admin unlock before editing it.');
    unlockRequestId = unlock.request_id;
  }
  await assertAttendanceDateAllowed(db, assignmentId, date, existing?.is_extra ?? false);

  const roster = await query<{ student_id: number }>(
    'SELECT student_id FROM v_assignment_roster WHERE assignment_id = $1', [assignmentId], db);
  const rosterIds = new Set(roster.map((row) => row.student_id));
  const invalidId = absentStudentIds.find((studentId) => !rosterIds.has(studentId));
  if (invalidId !== undefined) throw new HttpError(400, 'An absent student is not on this class roster.');

  const nextNumber = existing?.session_number ?? (await queryOne<{ n: number }>(`
    SELECT COALESCE(max(session_number), 0)::int + 1 AS n
    FROM attendance_session WHERE assignment_id = $1`, [assignmentId], db))!.n;
  const duration = assignment.session_type === 'Lab' ? 2 : 1;
  const saved = existing
    ? await queryOne<{ session_id: number; session_number: number }>(`
      UPDATE attendance_session
      SET session_status = 'Conducted', absent_student_ids = $2, marked_by = $3, marked_at = now()
      WHERE session_id = $1
      RETURNING session_id, session_number`,
    [existing.session_id, absentStudentIds, facultyId], db)
    : await queryOne<{ session_id: number; session_number: number }>(`
      INSERT INTO attendance_session
        (assignment_id, session_date, session_number, duration_hrs, session_status,
         absent_student_ids, marked_by, marked_at)
      VALUES ($1, $2, $3, $4, 'Conducted', $5, $6, now())
      RETURNING session_id, session_number`,
    [assignmentId, date, nextNumber, duration, absentStudentIds, facultyId], db);
  if (!saved) throw new Error('Attendance save did not return the saved session.');
  if (unlockRequestId !== null) {
    const actor = await queryOne<{ user_id: number }>(
      'SELECT user_id FROM app_user WHERE faculty_id = $1 AND role = $2', [facultyId, 'faculty'], db);
    if (!actor) throw new Error('Faculty account was not found while auditing an attendance edit.');
    await db.query(`
      INSERT INTO attendance_session_audit
        (session_id, request_id, actor_id, action, old_value, new_value)
      VALUES ($1, $2, $3, 'attendance_edit', $4::jsonb, $5::jsonb)`,
    [
      saved.session_id, unlockRequestId, actor.user_id,
      JSON.stringify({
        session_status: existing!.session_status, absent_student_ids: existing!.absent_student_ids,
        is_extra: existing!.is_extra, reason: existing!.reason,
      }),
      JSON.stringify({
        session_status: 'Conducted', absent_student_ids: absentStudentIds,
        is_extra: existing!.is_extra, reason: existing!.reason,
      }),
    ]);
  }
  return { ...saved, created: existing === undefined };
}

export async function saveFacultyExtraAttendance(
  db: Db,
  facultyId: number,
  assignmentId: number,
  date: string,
  absentStudentIds: number[],
  reason: string,
): Promise<{ session_id: number; session_number: number; created: true }> {
  await db.query('SELECT pg_advisory_xact_lock($1::integer)', [assignmentId]);
  const assignment = await queryOne<{ session_type: string; term_start: string; term_end: string }>(`
    SELECT ta.session_type, s.start_date AS term_start, s.end_date AS term_end
    FROM teaching_assignment ta
    JOIN academic_session s ON s.session_id = ta.academic_session_id
    WHERE ta.assignment_id = $1 AND ta.faculty_id = $2
      AND ta.academic_session_id = current_session_id()`, [assignmentId, facultyId], db);
  if (!assignment) throw notFound('Teaching assignment');
  if (date < assignment.term_start || date > assignment.term_end) {
    throw new HttpError(400, 'Attendance date must be within the academic session.');
  }
  await assertAttendanceDateAllowed(db, assignmentId, date, true);
  if (date < attendanceLockCutoff()) {
    throw new HttpError(403, 'Attendance sessions older than 14 days are locked.');
  }

  const roster = await query<{ student_id: number }>(
    'SELECT student_id FROM v_assignment_roster WHERE assignment_id = $1', [assignmentId], db);
  const rosterIds = new Set(roster.map((row) => row.student_id));
  const invalidId = absentStudentIds.find((studentId) => !rosterIds.has(studentId));
  if (invalidId !== undefined) throw new HttpError(400, 'An absent student is not on this class roster.');

  const nextNumber = (await queryOne<{ n: number }>(`
    SELECT COALESCE(max(session_number), 0)::int + 1 AS n
    FROM attendance_session WHERE assignment_id = $1`, [assignmentId], db))!.n;
  const duration = assignment.session_type === 'Lab' ? 2 : 1;
  const saved = await queryOne<{ session_id: number; session_number: number }>(`
    INSERT INTO attendance_session
      (assignment_id, session_date, session_number, duration_hrs, session_status,
       absent_student_ids, marked_by, marked_at, is_extra, reason, created_by)
    VALUES ($1, $2, $3, $4, 'Conducted', $5, $6, now(), true, $7, $6)
    RETURNING session_id, session_number`,
  [assignmentId, date, nextNumber, duration, absentStudentIds, facultyId, reason], db);
  if (!saved) throw new Error('Extra attendance save did not return the saved session.');
  return { ...saved, created: true };
}

async function assertAttendanceDateAllowed(
  db: Db, assignmentId: number, date: string, isExtra: boolean,
): Promise<void> {
  const result = await queryOne<{ today: string; day_of_week: number; scheduled_weekdays: number[]; has_timetable: boolean }>(`
    SELECT current_date::text AS today, extract(isodow FROM $2::date)::int AS day_of_week,
           COALESCE(array_agg(DISTINCT te.day_of_week)
             FILTER (WHERE te.entry_id IS NOT NULL), '{}')::int[] AS scheduled_weekdays,
           count(te.entry_id) > 0 AS has_timetable
    FROM teaching_assignment ta
    LEFT JOIN timetable_entry te ON te.assignment_id = ta.assignment_id
    WHERE ta.assignment_id = $1
    GROUP BY ta.assignment_id`, [assignmentId, date], db);
  if (!result) throw notFound('Teaching assignment');
  if (date > result.today) throw new HttpError(400, 'Attendance cannot be marked for a future date.');
  if (isExtra) return;

  if (ATTENDANCE_WEEKEND_DAYS.includes(result.day_of_week as 6 | 7)) {
    throw new HttpError(400, 'Attendance cannot be marked on weekends. Use Add extra session with a reason.');
  }
  if (result.has_timetable && !result.scheduled_weekdays.includes(result.day_of_week)) {
    throw new HttpError(400, 'This class has no scheduled session on the selected date.');
  }
}
