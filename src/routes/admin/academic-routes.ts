/** Admin: departments, programs & curriculum, course catalog, prerequisites, sessions, sections. */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, transaction } from '../../db.js';
import { audit } from '../../lib/audit.js';
import { notFound } from '../../lib/http-error.js';
import { pageInfo, parsePage, withQuery } from '../../lib/pagination.js';
import { getCurriculum } from '../../queries/shared-queries.js';
import { handleForm, idParam, nullIfEmpty } from './helpers.js';

export const academicRouter = Router();

const DEPT_IDS = ['AIDS', 'CIVIL', 'CSE', 'EE', 'ENTC', 'IT', 'MECH'];
const departments = (): Promise<{ dept_id: string; dept_name: string }[]> =>
  query('SELECT dept_id, dept_name FROM department ORDER BY dept_id');

// ---------------------------------------------------------------- departments
academicRouter.get('/departments', async (_req, res) => {
  const rows = await query(`
    SELECT d.*, f.first_name || ' ' || f.last_name AS hod_name, f.faculty_code AS hod_code,
           (SELECT count(*) FROM program p WHERE p.dept_id = d.dept_id)::int AS programs,
           (SELECT count(*) FROM course c WHERE c.dept_id = d.dept_id)::int AS courses,
           (SELECT count(*) FROM faculty x WHERE x.dept_id = d.dept_id AND x.status = 'Active')::int AS faculty,
           (SELECT count(*) FROM student s JOIN program p USING (program_id)
             WHERE p.dept_id = d.dept_id AND s.status = 'Active')::int AS students
    FROM department d LEFT JOIN faculty f ON f.faculty_id = d.hod_faculty_id ORDER BY d.dept_id`);
  res.render('admin/departments', { title: 'Departments', nav: 'departments', rows });
});

academicRouter.get('/departments/:id', async (req, res) => {
  const dept = await queryOne<Record<string, unknown>>('SELECT * FROM department WHERE dept_id = $1', [req.params.id]);
  if (!dept) throw notFound('Department');
  const faculty = await query(`SELECT faculty_id, faculty_code, first_name || ' ' || last_name AS name, designation
                               FROM faculty WHERE dept_id = $1 AND status = 'Active' ORDER BY faculty_code`, [req.params.id]);
  res.render('admin/department-edit', { title: `Edit ${String(dept.dept_name)}`, nav: 'departments', dept, faculty });
});

const departmentSchema = z.object({
  dept_name: z.string().trim().min(3, 'Department name is required').max(100),
  office_room: z.string().trim().max(20),
  contact_email: z.union([z.literal(''), z.email('Enter a valid contact e-mail').max(100)]),
  hod_faculty_id: z.coerce.number().int().positive('Choose an HOD'),
  is_active: z.literal('on').optional(),
});

academicRouter.post('/departments/:id', (req, res) => handleForm(req, res, departmentSchema, `/admin/departments/${req.params.id}`, async (v) => {
  const id = req.params.id as string;
  await transaction(async (db) => {
    const before = await queryOne('SELECT dept_name, office_room, contact_email, hod_faculty_id, is_active FROM department WHERE dept_id = $1', [id], db);
    if (!before) throw notFound('Department');
    await db.query(`UPDATE department SET dept_name = $2, office_room = $3, contact_email = $4, hod_faculty_id = $5, is_active = $6
                    WHERE dept_id = $1`, [id, v.dept_name, nullIfEmpty(v.office_room), nullIfEmpty(v.contact_email), v.hod_faculty_id, v.is_active === 'on']);
    await audit(req, { action: 'DEPARTMENT_UPDATE', entity: 'department', entityId: id, details: { before, after: v } }, db);
  });
  return 'Department updated.';
}));

// ---------------------------------------------------------------- programs & curriculum
academicRouter.get('/programs', async (_req, res) => {
  const rows = await query(`
    SELECT p.*, (SELECT count(*) FROM program_curriculum pc WHERE pc.program_id = p.program_id)::int AS placements,
           (SELECT count(*) FROM student s WHERE s.program_id = p.program_id AND s.status = 'Active')::int AS students
    FROM program p ORDER BY p.degree_level DESC, p.dept_id`);
  res.render('admin/programs', { title: 'Programs & curriculum', nav: 'programs', rows });
});

academicRouter.get('/programs/:id', async (req, res) => {
  const program = await queryOne<Record<string, unknown> & { total_semesters: number; program_name: string }>(
    'SELECT p.*, d.dept_name FROM program p JOIN department d USING (dept_id) WHERE program_id = $1', [req.params.id]);
  if (!program) throw notFound('Program');
  const [rows, courses] = await Promise.all([
    getCurriculum(req.params.id as string),
    query(`SELECT course_id, course_code, course_name FROM course
           WHERE is_active AND course_id NOT IN (SELECT course_id FROM program_curriculum WHERE program_id = $1)
           ORDER BY course_code`, [req.params.id]),
  ]);
  const semesters = Array.from({ length: program.total_semesters }, (_, i) => ({ no: i + 1, courses: rows.filter((r) => r.semester_no === i + 1) }));
  res.render('admin/program-detail', { title: program.program_name, nav: 'programs', program, semesters, courses });
});

const programSchema = z.object({
  program_name: z.string().trim().min(3).max(100),
  total_credits_req: z.coerce.number().positive('Credits must be positive').max(400),
  intake_capacity: z.coerce.number().int().positive('Intake must be positive').max(5000),
  is_active: z.literal('on').optional(),
});

academicRouter.post('/programs/:id', (req, res) => handleForm(req, res, programSchema, `/admin/programs/${req.params.id}`, async (v) => {
  await transaction(async (db) => {
    const r = await db.query('UPDATE program SET program_name = $2, total_credits_req = $3, intake_capacity = $4, is_active = $5 WHERE program_id = $1',
      [req.params.id, v.program_name, v.total_credits_req, v.intake_capacity, v.is_active === 'on']);
    if (!r.rowCount) throw notFound('Program');
    await audit(req, { action: 'PROGRAM_UPDATE', entity: 'program', entityId: req.params.id as string, details: v }, db);
  });
  return 'Program updated.';
}));

const placementSchema = z.object({
  course_id: z.coerce.number().int().positive('Choose a course'),
  semester_no: z.coerce.number().int().min(1).max(12),
  course_category: z.enum(['CORE', 'PROF_ELECTIVE', 'OPEN_ELECTIVE']),
  elective_group: z.string().trim().max(4).regex(/^[A-Z0-9]*$/, 'Elective group: letters and digits only, e.g. E1'),
});

academicRouter.post('/programs/:id/curriculum', (req, res) => handleForm(req, res, placementSchema, `/admin/programs/${req.params.id}`, async (v) => {
  await transaction(async (db) => {
    await db.query(`INSERT INTO program_curriculum (program_id, course_id, semester_no, course_category, elective_group)
                    VALUES ($1, $2, $3, $4, $5)`, [req.params.id, v.course_id, v.semester_no, v.course_category, nullIfEmpty(v.elective_group)]);
    await audit(req, { action: 'CURRICULUM_ADD', entity: 'program', entityId: req.params.id as string, details: v }, db);
  });
  return 'Course placed in the curriculum.';
}));

academicRouter.post('/programs/:id/curriculum/:courseId/delete', (req, res) =>
  handleForm(req, res, z.object({}), `/admin/programs/${req.params.id}`, async () => {
    await transaction(async (db) => {
      const r = await db.query('DELETE FROM program_curriculum WHERE program_id = $1 AND course_id = $2', [req.params.id, idParam(req.params.courseId)]);
      if (!r.rowCount) throw notFound('Curriculum placement');
      await audit(req, { action: 'CURRICULUM_REMOVE', entity: 'program', entityId: req.params.id as string, details: { course_id: req.params.courseId } }, db);
    });
    return 'Course removed from the curriculum.';
  }));

// ---------------------------------------------------------------- course catalog
academicRouter.get('/courses', async (req, res) => {
  const filters = {
    dept: DEPT_IDS.includes(String(req.query.dept)) ? String(req.query.dept) : '',
    type: ['TH', 'LAB', 'TUT'].includes(String(req.query.type)) ? String(req.query.type) : '',
    q: typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '',
  };
  const page = parsePage(req.query.page);
  const where = `($1::text = '' OR dept_id = $1::text) AND ($2::text = '' OR course_type::text = $2::text)
                 AND ($3::text = '' OR course_code ILIKE '%' || $3::text || '%' OR course_name ILIKE '%' || $3::text || '%')`;
  const params = [filters.dept, filters.type, filters.q];
  const [rows, count] = await Promise.all([
    query(`SELECT * FROM v_course_catalog WHERE ${where} ORDER BY course_code LIMIT $4 OFFSET $5`, [...params, page.limit, page.offset]),
    queryOne<{ n: number }>(`SELECT count(*) AS n FROM v_course_catalog WHERE ${where}`, params),
  ]);
  res.render('admin/courses', {
    title: 'Course catalog', nav: 'courses', rows, filters, depts: await departments(),
    pager: pageInfo(page, count?.n ?? 0), qs: (o: Record<string, unknown>) => withQuery(filters, o),
  });
});

const courseSchema = z.object({
  course_code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,12}$/, 'Course code: 3-12 letters/digits'),
  course_name: z.string().trim().min(3, 'Course name is required').max(120),
  dept_id: z.enum(DEPT_IDS as [string, ...string[]]),
  credits: z.coerce.number().positive('Credits must be positive').max(20),
  course_type: z.enum(['TH', 'LAB', 'TUT']),
  lecture_hrs: z.coerce.number().int().min(0).max(10),
  tutorial_hrs: z.coerce.number().int().min(0).max(10),
  practical_hrs: z.coerce.number().int().min(0).max(10),
  syllabus_version: z.string().trim().min(1).max(10),
  min_attendance_pct: z.coerce.number().int().min(0).max(100),
  is_active: z.literal('on').optional(),
});
type CourseForm = z.infer<typeof courseSchema>;
const courseValues = (v: CourseForm): unknown[] => [v.course_code, v.course_name, v.dept_id, v.credits, v.course_type,
  v.lecture_hrs, v.tutorial_hrs, v.practical_hrs, v.syllabus_version, v.min_attendance_pct, v.is_active === 'on'];

academicRouter.get('/courses/new', async (_req, res) => {
  res.render('admin/course-form', {
    title: 'New course', nav: 'courses', depts: await departments(),
    course: { course_type: 'TH', lecture_hrs: 3, tutorial_hrs: 0, practical_hrs: 0, credits: 3, syllabus_version: 'R2024', min_attendance_pct: 75, is_active: true },
  });
});

academicRouter.post('/courses', (req, res) => handleForm(req, res, courseSchema, '/admin/courses/new', async (v) => {
  const id = await transaction(async (db) => {
    const r = await db.query<{ course_id: number }>(`INSERT INTO course (course_code, course_name, dept_id, credits, course_type,
              lecture_hrs, tutorial_hrs, practical_hrs, syllabus_version, min_attendance_pct, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING course_id`, courseValues(v));
    const newId = r.rows[0]!.course_id;
    await audit(req, { action: 'COURSE_CREATE', entity: 'course', entityId: newId, details: v }, db);
    return newId;
  });
  return { message: `Course ${v.course_code} created.`, redirect: `/admin/courses/${id}` };
}));

academicRouter.get('/courses/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const course = await queryOne<Record<string, unknown> & { course_code: string; course_name: string }>(
    'SELECT c.*, d.dept_name FROM course c JOIN department d USING (dept_id) WHERE c.course_id = $1', [id]);
  if (!course) throw notFound('Course');
  const [prereqs, unlocks, placements, candidates, teaching] = await Promise.all([
    query(`SELECT c.course_id, c.course_code, c.course_name, p.min_grade FROM course_prerequisite p
           JOIN course c ON c.course_id = p.prereq_course_id WHERE p.course_id = $1 ORDER BY c.course_code`, [id]),
    query(`SELECT c.course_id, c.course_code, c.course_name FROM course_prerequisite p
           JOIN course c ON c.course_id = p.course_id WHERE p.prereq_course_id = $1 ORDER BY c.course_code`, [id]),
    query(`SELECT program_id, program_name, semester_no, course_category, elective_group, placement_kind
           FROM v_curriculum WHERE course_id = $1 ORDER BY program_id`, [id]),
    query(`SELECT course_id, course_code, course_name FROM course WHERE course_id <> $1
           AND course_id NOT IN (SELECT prereq_course_id FROM course_prerequisite WHERE course_id = $1) ORDER BY course_code`, [id]),
    queryOne<{ classes: number; faculty: number; students: number }>(`
      SELECT count(DISTINCT ta.assignment_id)::int AS classes, count(DISTINCT ta.faculty_id)::int AS faculty,
             (SELECT count(*) FROM student_enrollment e WHERE e.course_id = $1 AND e.academic_session_id = current_session_id())::int AS students
      FROM teaching_assignment ta WHERE ta.course_id = $1 AND ta.academic_session_id = current_session_id()`, [id]),
  ]);
  res.render('admin/course-detail', {
    title: `${course.course_code} · ${course.course_name}`, nav: 'courses', course, prereqs, unlocks, placements, candidates, teaching,
    depts: await departments(),
  });
});

academicRouter.post('/courses/:id', (req, res) => handleForm(req, res, courseSchema, `/admin/courses/${req.params.id}`, async (v) => {
  const id = idParam(req.params.id);
  await transaction(async (db) => {
    const before = await queryOne('SELECT * FROM course WHERE course_id = $1', [id], db);
    if (!before) throw notFound('Course');
    await db.query(`UPDATE course SET course_code = $1, course_name = $2, dept_id = $3, credits = $4, course_type = $5,
                      lecture_hrs = $6, tutorial_hrs = $7, practical_hrs = $8, syllabus_version = $9,
                      min_attendance_pct = $10, is_active = $11 WHERE course_id = $12`, [...courseValues(v), id]);
    await audit(req, { action: 'COURSE_UPDATE', entity: 'course', entityId: id, details: { before, after: v } }, db);
  });
  return 'Course updated.';
}));

const prereqSchema = z.object({
  prereq_course_id: z.coerce.number().int().positive('Choose a prerequisite course'),
  min_grade: z.enum(['O', 'A+', 'A', 'B+', 'B', 'C', 'P']),
});

academicRouter.post('/courses/:id/prerequisites', (req, res) => handleForm(req, res, prereqSchema, `/admin/courses/${req.params.id}`, async (v) => {
  const id = idParam(req.params.id);
  await transaction(async (db) => {
    // the prerequisite_no_cycle trigger rejects edges that would create a loop
    await db.query('INSERT INTO course_prerequisite (course_id, prereq_course_id, min_grade) VALUES ($1, $2, $3)', [id, v.prereq_course_id, v.min_grade]);
    await audit(req, { action: 'PREREQUISITE_ADD', entity: 'course', entityId: id, details: v }, db);
  });
  return 'Prerequisite added.';
}));

academicRouter.post('/courses/:id/prerequisites/:prereqId/delete', (req, res) =>
  handleForm(req, res, z.object({}), `/admin/courses/${req.params.id}`, async () => {
    const id = idParam(req.params.id);
    const prereq = idParam(req.params.prereqId);
    await transaction(async (db) => {
      const r = await db.query('DELETE FROM course_prerequisite WHERE course_id = $1 AND prereq_course_id = $2', [id, prereq]);
      if (!r.rowCount) throw notFound('Prerequisite');
      await audit(req, { action: 'PREREQUISITE_REMOVE', entity: 'course', entityId: id, details: { prereq_course_id: prereq } }, db);
    });
    return 'Prerequisite removed.';
  }));

// ---------------------------------------------------------------- academic sessions
academicRouter.get('/sessions', async (_req, res) => {
  const rows = await query(`
    SELECT s.*, (SELECT count(*) FROM student_enrollment e WHERE e.academic_session_id = s.session_id)::int AS enrollments,
           (SELECT count(*) FROM teaching_assignment t WHERE t.academic_session_id = s.session_id)::int AS assignments
    FROM academic_session s ORDER BY s.start_date DESC`);
  res.render('admin/sessions', { title: 'Academic sessions', nav: 'sessions', rows });
});

const sessionSchema = z.object({
  start_year: z.coerce.number().int().min(2000).max(2100),
  term_type: z.enum(['ODD', 'EVEN']),
  start_date: z.iso.date('Enter a start date'),
  end_date: z.iso.date('Enter an end date'),
});

academicRouter.post('/sessions', (req, res) => handleForm(req, res, sessionSchema, '/admin/sessions', async (v) => {
  const ay = `${v.start_year}-${String(v.start_year + 1).slice(2)}`;
  const id = `${v.start_year}-${v.term_type}`;
  await transaction(async (db) => {
    await db.query(`INSERT INTO academic_session (session_id, session_name, academic_year, term_type, start_date, end_date)
                    VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, `${v.term_type === 'ODD' ? 'Odd' : 'Even'} Semester ${ay}`, ay, v.term_type, v.start_date, v.end_date]);
    await audit(req, { action: 'SESSION_CREATE', entity: 'academic_session', entityId: id, details: v }, db);
  });
  return `Session ${id} created.`;
}));

academicRouter.post('/sessions/:id/current', (req, res) =>
  handleForm(req, res, z.object({ confirm: z.literal(String(req.params.id), 'Type the session id to confirm') }), '/admin/sessions', async () => {
    await transaction(async (db) => {
      await db.query('CALL set_current_session($1)', [req.params.id]);
      await audit(req, { action: 'SESSION_SET_CURRENT', entity: 'academic_session', entityId: req.params.id as string }, db);
    });
    return `${req.params.id as string} is now the current session.`;
  }));

// ---------------------------------------------------------------- divisions & sections
academicRouter.get('/sections', async (req, res) => {
  const filters = {
    dept: DEPT_IDS.includes(String(req.query.dept)) ? String(req.query.dept) : '',
    year: ['1', '2', '3', '4'].includes(String(req.query.year)) ? String(req.query.year) : '',
  };
  const [divisions, offerings] = await Promise.all([
    // one pass over the attendance totals (a per-division subquery re-aggregated them 547 times)
    query(`WITH divs AS (
             SELECT division_id, division_code, dept_id, year_of_study, semester FROM division
             WHERE academic_session_id = current_session_id()
               AND ($1::text = '' OR dept_id = $1::text) AND ($2::text = '' OR year_of_study::text = $2::text)),
           per_student AS (
             SELECT ss.division_id, a.student_id, 100.0 * sum(a.attended) / NULLIF(sum(a.total_sessions), 0) AS pct
             FROM attendance_summary a
             JOIN student_section ss ON ss.student_id = a.student_id AND ss.academic_session_id = a.academic_session_id
             WHERE a.academic_session_id = current_session_id() AND ss.division_id IN (SELECT division_id FROM divs)
             GROUP BY ss.division_id, a.student_id),
           per_division AS (SELECT division_id, round(avg(pct), 1) AS avg_pct FROM per_student GROUP BY division_id),
           strength AS (
             SELECT division_id, count(*)::int AS strength FROM student_section
             WHERE academic_session_id = current_session_id() GROUP BY division_id)
           SELECT d.*, COALESCE(s.strength, 0) AS strength, p.avg_pct,
                  (SELECT count(*) FROM batch b WHERE b.division_id = d.division_id)::int AS batches
           FROM divs d LEFT JOIN per_division p USING (division_id) LEFT JOIN strength s USING (division_id)
           ORDER BY d.division_code`, [filters.dept, filters.year]),
    query(`SELECT o.*, c.course_code, c.course_name, f.first_name || ' ' || f.last_name AS faculty_name, r.room_code
           FROM course_offering o JOIN course c USING (course_id) LEFT JOIN faculty f USING (faculty_id) LEFT JOIN room r USING (room_id)
           WHERE o.academic_session_id = current_session_id() AND ($1::text = '' OR c.dept_id = $1::text)
           ORDER BY c.course_code, o.section_name`, [filters.dept]),
  ]);
  res.render('admin/sections', { title: 'Divisions & sections', nav: 'sections', divisions, offerings, filters, depts: await departments() });
});

academicRouter.get('/sections/divisions/:id', async (req, res) => {
  const id = idParam(req.params.id);
  const division = await queryOne<Record<string, unknown> & { division_code: string }>(
    'SELECT v.*, d.dept_name FROM v_division_strength v JOIN department d USING (dept_id) WHERE v.division_id = $1', [id]);
  if (!division) throw notFound('Division');
  const [students, teaching] = await Promise.all([
    query(`SELECT s.student_id, s.student_number, s.first_name || ' ' || s.last_name AS name, ss.roll_no, b.batch_code, o.overall_pct
           FROM student_section ss JOIN student s USING (student_id) JOIN batch b USING (batch_id)
           LEFT JOIN v_student_attendance_overall o ON o.student_id = ss.student_id AND o.academic_session_id = ss.academic_session_id
           WHERE ss.division_id = $1 ORDER BY ss.roll_no`, [id]),
    query(`SELECT ta.assignment_id, ta.session_type, ta.weekly_sessions, c.course_code, c.course_name, b.batch_code,
                  f.faculty_id, f.faculty_code, f.first_name || ' ' || f.last_name AS faculty_name
           FROM teaching_assignment ta JOIN course c USING (course_id) JOIN faculty f USING (faculty_id) LEFT JOIN batch b USING (batch_id)
           WHERE ta.division_id = $1 ORDER BY c.course_code, b.batch_code`, [id]),
  ]);
  res.render('admin/division-detail', { title: `Division ${division.division_code}`, nav: 'sections', division, students, teaching });
});
