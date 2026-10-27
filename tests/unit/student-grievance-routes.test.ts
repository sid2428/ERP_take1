import express, { type Request } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../src/types.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  friendlyDbError: vi.fn(),
  audit: vi.fn(),
  actAs: vi.fn(),
  getCourseTeachers: vi.fn(),
  getGrievanceFor: vi.fn(),
  getThread: vi.fn(),
  listRaisedBy: vi.fn(),
  listAssignedTo: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
  friendlyDbError: mocks.friendlyDbError,
  transaction: async (fn: (client: { query: typeof mocks.query }) => Promise<unknown>) => fn({ query: mocks.query }),
}));

vi.mock('../../src/lib/audit.js', () => ({
  audit: mocks.audit,
}));

vi.mock('../../src/queries/grievance-queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/queries/grievance-queries.js')>();
  return {
    ...actual,
    actAs: mocks.actAs,
    getCourseTeachers: mocks.getCourseTeachers,
    getGrievanceFor: mocks.getGrievanceFor,
    getThread: mocks.getThread,
    listRaisedBy: mocks.listRaisedBy,
    listAssignedTo: mocks.listAssignedTo,
  };
});

import { errorHandler } from '../../src/middleware/errors.js';
import { grievanceRouter } from '../../src/routes/grievance-routes.js';

const student: CurrentUser = {
  userId: 42,
  loginId: 'STU202600042',
  role: 'student',
  studentId: 402,
  facultyId: null,
  displayName: 'Test Student',
  deptId: 'CE',
  mustChangePassword: false,
};

const facultyUser: CurrentUser = {
  userId: 99,
  loginId: 'FAC099',
  role: 'faculty',
  studentId: null,
  facultyId: 199,
  displayName: 'Faculty Member',
  deptId: 'CE',
  mustChangePassword: false,
};

function appAs(user?: CurrentUser, session: { flash?: { type: string; text: string } } = {}): express.Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = user;
    Object.defineProperty(req, 'session', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: session,
    });
    next();
  });
  app.use('/student/grievances', grievanceRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({ rows: [{ grievance_id: 101 }] });
  mocks.queryOne.mockResolvedValue(undefined);
  mocks.friendlyDbError.mockReturnValue(null);
  mocks.audit.mockResolvedValue(undefined);
  mocks.actAs.mockResolvedValue(undefined);
  mocks.getCourseTeachers.mockResolvedValue([
    {
      course_id: 1,
      course_code: 'CS201',
      course_name: 'Data Structures',
      faculty_id: 10,
      faculty_name: 'Prof. Sharma',
      session_type: 'Lecture',
    },
    {
      course_id: 1,
      course_code: 'CS201',
      course_name: 'Data Structures',
      faculty_id: 11,
      faculty_name: 'Prof. Patel',
      session_type: 'Lab',
    },
    {
      course_id: 2,
      course_code: 'CS202',
      course_name: 'Database Systems',
      faculty_id: 20,
      faculty_name: 'Prof. Kulkarni',
      session_type: 'Lecture',
    },
  ]);
});

describe('student grievance submission route (POST /student/grievances)', () => {
  it('successfully submits a general grievance and redirects to detail page', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    const res = await request(appAs(student, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'general',
        category: 'Facilities',
        subject: 'Projector broken in lab A-101',
        description: 'The projector in A-101 has not worked for over two weeks.',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/101');
    expect(mocks.actAs).toHaveBeenCalledWith(expect.anything(), student.userId);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO grievance (raised_by, raised_by_role, category, subject, description)'),
      [student.userId, 'student', 'Facilities', 'Projector broken in lab A-101', 'The projector in A-101 has not worked for over two weeks.'],
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'GRIEVANCE_CREATE',
        entity: 'grievance',
        entityId: 101,
        details: { category: 'Facilities', subject: 'Projector broken in lab A-101' },
      }),
      expect.anything(),
    );
    expect(session.flash).toEqual({
      type: 'success',
      text: 'Grievance #101 submitted. The academic office will review it.',
    });
  });

  it('successfully submits a course grievance with specified teacher', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    const res = await request(appAs(student, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'course',
        course_id: '1',
        faculty_id: '11',
        category: 'Academic',
        subject: 'Lab evaluation doubt',
        description: 'Need clarification on test 2 lab evaluation rubric.',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/101');
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO grievance (raised_by, raised_by_role, category, subject, description, course_id, assigned_to)'),
      [student.userId, 'student', 'Academic', 'Lab evaluation doubt', 'Need clarification on test 2 lab evaluation rubric.', 1, 11],
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'GRIEVANCE_CREATE',
        entity: 'grievance',
        entityId: 101,
        details: { category: 'Academic', subject: 'Lab evaluation doubt', courseId: 1, facultyId: 11 },
      }),
      expect.anything(),
    );
    expect(session.flash?.text).toContain('sent to Prof. Patel');
  });

  it('automatically assigns default (theory) teacher when faculty_id is omitted for a course', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    const res = await request(appAs(student, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'course',
        course_id: '1',
        faculty_id: '',
        category: 'Academic',
        subject: 'Lecture attendance mismatch',
        description: 'Attendance not recorded for lecture on Monday.',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/101');
    // Prof. Sharma is the first teacher (Lecture) for course 1
    expect(mocks.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([1, 10]),
    );
    expect(session.flash?.text).toContain('sent to Prof. Sharma');
  });

  it('rejects invalid request data and redirects to /new without database insert', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    const res = await request(appAs(student, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'general',
        category: 'Facilities',
        subject: 'bad', // too short (< 5 chars)
        description: 'short', // too short (< 10 chars)
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/new');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(session.flash?.type).toBe('error');
    expect(session.flash?.text).toMatch(/at least 5 characters/);
  });

  it('rejects invalid course selection not in student enrolled courses', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    const res = await request(appAs(student, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'course',
        course_id: '999', // not enrolled
        category: 'Academic',
        subject: 'Question on unknown course',
        description: 'I would like to know about this other course syllabus.',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/new');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(session.flash).toEqual({
      type: 'error',
      text: 'Choose one of your courses for this term.',
    });
  });

  it('handles database insert failure gracefully without HTTP 500 or leak', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    const dbError = new Error('column "course_id" of relation "grievance" does not exist');
    Object.assign(dbError, { code: '42703' });
    mocks.query.mockRejectedValueOnce(dbError);

    const res = await request(appAs(student, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'course',
        course_id: '1',
        category: 'Academic',
        subject: 'Course syllabus inquiry',
        description: 'Question about unit 4 examination topics and pattern.',
      });

    // Must be handled gracefully: redirect to /new with error flash, NOT 500!
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/new');
    expect(session.flash).toEqual({
      type: 'error',
      text: 'Could not submit your grievance. Please try again.',
    });
    // Ensure no raw SQL or DB error is leaked to the user
    expect(session.flash?.text).not.toContain('course_id');
    expect(session.flash?.text).not.toContain('relation');
  });

  it('handles audit-log failure and rolls back transaction cleanly without HTTP 500', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    mocks.audit.mockRejectedValueOnce(new Error('audit_log connection timeout'));

    const res = await request(appAs(student, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'general',
        category: 'Fees',
        subject: 'Fee receipt duplicate download',
        description: 'Cannot download receipt for payment made yesterday.',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/new');
    expect(session.flash).toEqual({
      type: 'error',
      text: 'Could not submit your grievance. Please try again.',
    });
  });

  it('handles course-teacher lookup failure gracefully without HTTP 500', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    mocks.getCourseTeachers.mockRejectedValueOnce(new Error('database unavailable'));

    const res = await request(appAs(student, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'course',
        course_id: '1',
        category: 'Academic',
        subject: 'Lab evaluation doubt',
        description: 'Need clarification on test 2 lab evaluation rubric.',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/new');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(session.flash).toEqual({
      type: 'error',
      text: 'Could not load your course teachers. Please try again.',
    });
  });

  it('rejects course grievances attempted by non-student accounts', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    const res = await request(appAs(facultyUser, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'course',
        course_id: '1',
        category: 'Academic',
        subject: 'Faculty course grievance',
        description: 'Faculty attempting course grievance raising.',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/new');
    expect(mocks.query).not.toHaveBeenCalled();
    expect(session.flash).toEqual({
      type: 'error',
      text: 'Only students can raise a grievance about a course.',
    });
  });

  it('renders check constraint violations with friendly messages from friendlyDbError', async () => {
    const session: { flash?: { type: string; text: string } } = {};
    const constraintErr = new Error('new row violates check constraint "grievance_subject_check"');
    Object.assign(constraintErr, { code: '23514' });
    mocks.friendlyDbError.mockReturnValueOnce('Value not allowed: invalid subject content.');
    mocks.query.mockRejectedValueOnce(constraintErr);

    const res = await request(appAs(student, session))
      .post('/student/grievances')
      .type('form')
      .send({
        about: 'general',
        category: 'Other',
        subject: 'General feedback topic',
        description: 'General feedback about campus library hours.',
      });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/student/grievances/new');
    expect(session.flash).toEqual({
      type: 'error',
      text: 'Value not allowed: invalid subject content.',
    });
  });
});
