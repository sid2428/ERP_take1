import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../src/types.js';

const { query, queryOne } = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));
vi.mock('../../src/db.js', () => ({ query, queryOne }));

const { apiRouter } = await import('../../src/routes/api-routes.js');

function appFor(user?: CurrentUser) {
  const app = express();
  app.use((req, _res, next) => {
    if (user) req.user = user;
    next();
  });
  app.use(apiRouter);
  return app;
}

const admin: CurrentUser = {
  userId: 3, loginId: 'admin', role: 'admin', studentId: null, facultyId: null,
  displayName: 'Admin', deptId: null, mustChangePassword: false,
};
const student: CurrentUser = {
  userId: 5, loginId: 'STU1', role: 'student', studentId: 1, facultyId: null,
  displayName: 'Student', deptId: 'CSE', mustChangePassword: false,
};

describe('faculty HR API authorization', () => {
  beforeEach(() => {
    query.mockReset().mockResolvedValue([]);
    queryOne.mockReset();
  });

  it('requires an authenticated admin for HR endpoints', async () => {
    const anonymous = await request(appFor()).get('/admin/hr/leave/requests');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toContain('/login');

    const denied = await request(appFor(student)).get('/admin/hr/leave/requests');
    expect(denied.status).toBe(403);
    expect(query).not.toHaveBeenCalled();

    const allowed = await request(appFor(admin)).get('/admin/hr/leave/requests');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual([]);
  });

  it('limits leave type metadata to authenticated faculty', async () => {
    const anonymous = await request(appFor()).get('/leave/types');
    expect(anonymous.status).toBe(302);

    const denied = await request(appFor(student)).get('/leave/types');
    expect(denied.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });
});
