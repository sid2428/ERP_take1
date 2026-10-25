import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfFrom, hasAppEnv, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { pool } = hasAppEnv ? await import('../../src/db.js') : { pool: null };

describe.skipIf(!hasAppEnv)('faculty dashboard CSP interactions', () => {
  const app = createApp!();
  let faculty: Awaited<ReturnType<typeof signIn>>['agent'];
  let facultyId = 0;

  beforeAll(async () => {
    faculty = (await signIn(app, 'FAC-CSE-074', DEMO)).agent;
    facultyId = (await pool!.query<{ faculty_id: number }>(
      "SELECT faculty_id FROM faculty WHERE faculty_code = 'FAC-CSE-074'",
    )).rows[0]!.faculty_id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('renders the authenticated dashboard with restrictive CSP and external behavior', async () => {
    const page = await faculty.get('/faculty');
    expect(page.status).toBe(200);
    expect(csrfFrom(page.text)).toBeTruthy();
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.text).toContain(`data-faculty-id="${facultyId}"`);
    expect(page.text).toContain('/static/js/faculty-dashboard.js');
    expect(page.text).not.toMatch(/\son[a-z]+\s*=/i);
    expect(page.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);

    const script = await faculty.get('/static/js/faculty-dashboard.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect(script.text).not.toMatch(/\son[a-z]+\s*=/i);
    expect(script.text).toContain("document.addEventListener('click'");
    expect(script.text).toContain("document.addEventListener('change'");
    expect(script.text).toContain("document.addEventListener('submit'");
    for (const action of ['navigate', 'view-roster', 'view-session-register', 'mark-all', 'submit-attendance',
      'export-low-attendance', 'cancel-leave', 'view-payslip', 'update-profile', 'open-grievance-form',
      'close-grievance-form', 'print-payslip']) {
      expect(script.text).toContain(`case '${action}'`);
    }
    for (const action of ['student-offering-filter', 'mark-offering-change', 'records-offering-filter',
      'calculate-leave-days']) {
      expect(script.text).toContain(`action === '${action}'`);
    }
    expect(script.text).toContain(`event.target.matches('[data-action="filter-students"]')`);
  });
});
