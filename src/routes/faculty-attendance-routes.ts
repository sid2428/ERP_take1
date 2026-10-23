import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../lib/http-error.js';
import { transaction } from '../db.js';
import {
  getFacultyAttendanceAssignments,
  getFacultyAttendanceRoster,
  getFacultyAttendanceSessions,
  saveFacultyAttendance,
} from '../queries/faculty-attendance-queries.js';

export const facultyAttendanceRouter = Router();

function assignmentId(value: string | undefined): number {
  const result = z.coerce.number().int().positive().safeParse(value);
  if (!result.success) throw new HttpError(400, 'Teaching assignment ID must be a positive integer.');
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
  const roster = await getFacultyAttendanceRoster(req.user!.facultyId!, id, parsedDate.data);
  res.json(roster);
});

facultyAttendanceRouter.get('/assignments/:assignmentId/sessions', async (req, res) => {
  const id = assignmentId(req.params.assignmentId);
  const sessions = await getFacultyAttendanceSessions(req.user!.facultyId!, id);
  res.json({ sessions });
});

const saveFields = z.object({
  session_date: z.iso.date(),
  absent_student_ids: z.string().max(100_000),
});

facultyAttendanceRouter.post('/assignments/:assignmentId/sessions', async (req, res) => {
  const id = assignmentId(req.params.assignmentId);
  const parsed = saveFields.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Provide an attendance date and absent student list.');

  let absentStudentIds: unknown;
  try {
    absentStudentIds = JSON.parse(parsed.data.absent_student_ids);
  } catch {
    throw new HttpError(400, 'The absent student list is not valid JSON.');
  }
  const ids = z.array(z.number().int().positive()).max(5_000).safeParse(absentStudentIds);
  if (!ids.success || new Set(ids.data).size !== ids.data.length) {
    throw new HttpError(400, 'The absent student list must contain unique positive student IDs.');
  }

  const saved = await transaction((client) =>
    saveFacultyAttendance(client, req.user!.facultyId!, id, parsed.data.session_date, ids.data));
  res.status(saved.created ? 201 : 200).json({ ...saved, message: 'Attendance saved.' });
});
