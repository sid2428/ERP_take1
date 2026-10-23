import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../lib/http-error.js';
import { transaction } from '../db.js';
import { requestFacultyAttendanceUnlock } from '../queries/attendance-unlock-queries.js';
import {
  getFacultyAttendanceAssignments,
  getFacultyAttendanceCalendar,
  getFacultyAttendanceRoster,
  getFacultyAttendanceSessions,
  saveFacultyAttendance,
  saveFacultyExtraAttendance,
} from '../queries/faculty-attendance-queries.js';

export const facultyAttendanceRouter = Router();

function assignmentId(value: string | undefined): number {
  const result = z.coerce.number().int().positive().safeParse(value);
  if (!result.success) throw new HttpError(400, 'Teaching assignment ID must be a positive integer.');
  return result.data;
}

function sessionId(value: string | undefined): number {
  const result = z.coerce.number().int().positive().safeParse(value);
  if (!result.success) throw new HttpError(400, 'Attendance session ID must be a positive integer.');
  return result.data;
}

facultyAttendanceRouter.get('/', (_req, res) => {
  res.render('faculty/attendance', { title: 'Attendance', nav: 'attendance' });
});

facultyAttendanceRouter.get('/assignments', async (req, res) => {
  const assignments = await getFacultyAttendanceAssignments(req.user!.facultyId!);
  res.json({ assignments });
});

facultyAttendanceRouter.get('/assignments/:assignmentId/roster', async (req, res) => {
  const id = assignmentId(req.params.assignmentId);
  const parsedDate = z.iso.date().safeParse(req.query.date);
  if (!parsedDate.success) throw new HttpError(400, 'Provide a valid attendance date in YYYY-MM-DD format.');
  const parsedSession = req.query.session_id === undefined
    ? undefined : z.coerce.number().int().positive().safeParse(req.query.session_id);
  if (parsedSession && !parsedSession.success) throw new HttpError(400, 'Attendance session ID must be a positive integer.');
  const roster = await getFacultyAttendanceRoster(
    req.user!.facultyId!, id, parsedDate.data, parsedSession?.data,
  );
  res.json(roster);
});

facultyAttendanceRouter.get('/assignments/:assignmentId/calendar', async (req, res) => {
  const id = assignmentId(req.params.assignmentId);
  const calendar = await getFacultyAttendanceCalendar(req.user!.facultyId!, id);
  res.json({ calendar });
});

facultyAttendanceRouter.get('/assignments/:assignmentId/sessions', async (req, res) => {
  const id = assignmentId(req.params.assignmentId);
  const sessions = await getFacultyAttendanceSessions(req.user!.facultyId!, id);
  res.json({ sessions });
});

const unlockRequestFields = z.object({
  reason: z.string().trim().min(1, 'Provide a reason for the unlock request.').max(500),
});

facultyAttendanceRouter.post('/assignments/:assignmentId/sessions/:sessionId/unlock-requests', async (req, res) => {
  const parsed = unlockRequestFields.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Provide a reason for the unlock request.');
  }
  const saved = await transaction((db) => requestFacultyAttendanceUnlock(
    db, req.user!.facultyId!, req.user!.userId, assignmentId(req.params.assignmentId),
    sessionId(req.params.sessionId), parsed.data.reason,
  ));
  res.status(201).json({ ...saved, message: 'Unlock request submitted for admin review.' });
});

const saveFields = z.object({
  session_date: z.iso.date(),
  absent_student_ids: z.string().max(100_000),
  session_id: z.coerce.number().int().positive().optional(),
});
const extraFields = saveFields.extend({
  reason: z.string().trim().min(1, 'Provide a reason for the extra session.').max(500),
});

function parseAbsentStudentIds(value: string): number[] {
  let absentStudentIds: unknown;
  try {
    absentStudentIds = JSON.parse(value);
  } catch {
    throw new HttpError(400, 'The absent student list is not valid JSON.');
  }
  const ids = z.array(z.number().int().positive()).max(5_000).safeParse(absentStudentIds);
  if (!ids.success || new Set(ids.data).size !== ids.data.length) {
    throw new HttpError(400, 'The absent student list must contain unique positive student IDs.');
  }
  return ids.data;
}

facultyAttendanceRouter.post('/assignments/:assignmentId/sessions', async (req, res) => {
  const id = assignmentId(req.params.assignmentId);
  const parsed = saveFields.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Provide an attendance date and absent student list.');

  const saved = await transaction((client) =>
    saveFacultyAttendance(client, req.user!.facultyId!, id, parsed.data.session_date,
      parseAbsentStudentIds(parsed.data.absent_student_ids), parsed.data.session_id));
  res.status(saved.created ? 201 : 200).json({ ...saved, message: 'Attendance saved.' });
});

facultyAttendanceRouter.post('/assignments/:assignmentId/extra-sessions', async (req, res) => {
  const id = assignmentId(req.params.assignmentId);
  const parsed = extraFields.safeParse(req.body);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Provide an attendance date, reason, and absent student list.');
  }
  const saved = await transaction((client) =>
    saveFacultyExtraAttendance(client, req.user!.facultyId!, id, parsed.data.session_date,
      parseAbsentStudentIds(parsed.data.absent_student_ids), parsed.data.reason));
  res.status(201).json({ ...saved, message: 'Extra session and attendance saved.' });
});
