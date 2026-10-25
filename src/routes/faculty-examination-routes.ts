import { Router } from 'express';
import { z } from 'zod';
import { transaction } from '../db.js';
import { HttpError } from '../lib/http-error.js';
import {
  getFacultyExamCourse,
  getFacultyExamCourses,
  saveFacultyExamMarks,
} from '../queries/faculty-examination-queries.js';

export const facultyExaminationRouter = Router();

function positiveId(value: string | undefined, label: string): number {
  const result = z.coerce.number().int().positive().safeParse(value);
  if (!result.success) throw new HttpError(400, `${label} must be a positive integer.`);
  return result.data;
}

facultyExaminationRouter.get('/', (_req, res) => {
  res.render('faculty/examination', { title: 'Examination', nav: 'examination' });
});

facultyExaminationRouter.get('/courses', async (req, res) => {
  const courses = await getFacultyExamCourses(req.user!.facultyId!);
  res.json({ courses });
});

facultyExaminationRouter.get('/courses/:courseId', async (req, res) => {
  const courseId = positiveId(req.params.courseId, 'Course ID');
  const rawCycleId = req.query.exam_cycle_id;
  if (rawCycleId !== undefined && typeof rawCycleId !== 'string') {
    throw new HttpError(400, 'Examination cycle ID must be a positive integer.');
  }
  const cycleId = rawCycleId === undefined ? undefined : positiveId(rawCycleId, 'Examination cycle ID');
  const result = await getFacultyExamCourse(req.user!.facultyId!, courseId, cycleId);
  res.json(result);
});

const markValue = z.number().finite().min(0).max(9999).refine(
  (value) => Number.isInteger(Number((value * 10).toFixed(8))),
  'Marks may have at most one decimal place.',
).nullable();
const entriesSchema = z.array(z.object({
  student_id: z.number().int().positive(),
  internal_marks: markValue,
  midsem_marks: markValue,
  endsem_marks: markValue,
})).min(1).max(5_000);
const saveSchema = z.object({
  exam_cycle_id: z.coerce.number().int().positive(),
  entries_json: z.string().max(100_000),
});

facultyExaminationRouter.post('/courses/:courseId/marks', async (req, res) => {
  const courseId = positiveId(req.params.courseId, 'Course ID');
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Provide an examination cycle and valid marks.');

  let rawEntries: unknown;
  try {
    rawEntries = JSON.parse(parsed.data.entries_json);
  } catch {
    throw new HttpError(400, 'The marks list is not valid JSON.');
  }
  const entries = entriesSchema.safeParse(rawEntries);
  if (!entries.success || new Set(entries.data.map((entry) => entry.student_id)).size !== entries.data.length) {
    throw new HttpError(400, 'Marks must contain unique student IDs and valid component scores.');
  }

  const saved = await transaction((client) => saveFacultyExamMarks(
    client, req.user!.facultyId!, courseId, parsed.data.exam_cycle_id, entries.data,
  ));
  res.json({ ...saved, message: 'Marks saved and course results updated.' });
});
