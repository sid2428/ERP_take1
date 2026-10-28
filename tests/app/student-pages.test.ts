import { describe, expect, it } from 'vitest';
import { hasAppEnv, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };

describe.skipIf(!hasAppEnv)('student attendance and examination pages', () => {
  const app = hasAppEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);

  it('renders each authenticated student records page with its client view', async () => {
    const { agent, res: login } = await signIn(app, 'STU202600004', DEMO);
    expect(login.status).toBe(302);
    const pages = [
      ['/student/attendance', 'attendance-summary'],
      ['/student/attendance/detail', 'attendance-detail'],
      ['/student/exams', 'exam-schedule'],
      ['/student/hall-ticket', 'hall-ticket'],
      ['/student/results', 'results'],
    ] as const;

    for (const [path, view] of pages) {
      const response = await agent.get(path);
      expect(response.status, path).toBe(200);
      expect(response.text).toContain(`data-student-view="${view}"`);
      expect(response.text).toContain('/static/js/student-records.js');
    }
  });
});
