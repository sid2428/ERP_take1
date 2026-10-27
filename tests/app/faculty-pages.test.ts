import { beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const FACULTY = 'FAC-CSE-074';

const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };

describe.skipIf(!hasAppEnv)('Faculty HTML Pages & Backend Actions', () => {
  const app = hasAppEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);
  type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
  let agent: Agent;

  beforeAll(async () => {
    agent = (await signIn(app, FACULTY, DEMO)).agent;
  });

  it('1. GET /faculty renders clean dashboard with layout-start shell and HR metrics', async () => {
    const res = await agent.get('/faculty');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Dashboard');
    expect(res.text).toContain('FAC-CSE-074');
    expect(res.text).toContain('Leave balance · 2026');
    expect(res.text).toContain('Latest payroll');
    expect(res.text).toContain('Courses taught');
    // Ensure no broken old fake SPA or inline onclicks remain
    expect(res.text).not.toContain('switchFaculty(74)');
  });

  it('2. GET /faculty/leave renders leave management with balances and application form', async () => {
    const res = await agent.get('/faculty/leave');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Leave Management');
    expect(res.text).toContain('Apply for Leave');
    expect(res.text).toContain('My Leave Requests');
    expect(res.text).toContain('Casual Leave');
    expect(res.text).toContain('name="_csrf"');
  });

  it('3. POST /faculty/leave/apply creates a leave request with CSRF and displays flash', async () => {
    const res = await postForm(agent, '/faculty/leave', '/faculty/leave/apply', {
      leave_type_id: '1',
      from_date: '2026-11-16',
      to_date: '2026-11-17',
      days_requested: '2',
      reason: 'Research symposium attendance',
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/faculty/leave');

    // Follow redirect to inspect rendered page and flash message
    const page = await agent.get('/faculty/leave');
    expect(page.status).toBe(200);
    expect(page.text).toContain('submitted successfully');
    expect(page.text).toContain('Research symposium attendance');
  });

  it('4. POST /faculty/leave/cancel/:id cancels the pending leave request', async () => {
    // Find the request ID created
    const leavePage = await agent.get('/faculty/leave');
    const match = leavePage.text.match(/\/faculty\/leave\/cancel\/(\d+)/);
    expect(match).not.toBeNull();
    const reqId = match![1];

    const cancelRes = await postForm(agent, '/faculty/leave', `/faculty/leave/cancel/${reqId}`, {
      remarks: 'Cancelled by faculty member',
    });
    expect(cancelRes.status).toBe(302);
    expect(cancelRes.headers.location).toBe('/faculty/leave');

    const afterPage = await agent.get('/faculty/leave');
    expect(afterPage.status).toBe(200);
    expect(afterPage.text).toContain(`Leave request #${reqId} was cancelled.`);
  });

  it('5. GET /faculty/payroll renders salary structure and monthly payslips', async () => {
    const res = await agent.get('/faculty/payroll');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Payslips &amp; Salary Structure');
    expect(res.text).toContain('Basic monthly pay');
    expect(res.text).toContain('Monthly Payslips');
    expect(res.text).toContain('View statement');
  });

  it('6. GET /faculty/payroll/:id renders official salary statement', async () => {
    // Grab first payslip statement link from /faculty/payroll
    const payrollPage = await agent.get('/faculty/payroll');
    const match = payrollPage.text.match(/\/faculty\/payroll\/(\d+)/);
    expect(match).not.toBeNull();
    const payrollId = match![1];

    const res = await agent.get(`/faculty/payroll/${payrollId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Salary Statement');
    expect(res.text).toContain('Gross Earnings');
    expect(res.text).toContain('Net Take-Home Pay');
    expect(res.text).toContain('FAC-CSE-074');
  });

  it('7. GET /admin/leave renders faculty leave management console for admin', async () => {
    const adminPassword = process.env.ADMIN_PASSWORD || DEMO;
    const adminAgent = (await signIn(app, 'admin', adminPassword)).agent;
    const res = await adminAgent.get('/admin/leave');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Faculty Leave Management');
    expect(res.text).toContain('Pending requests');
    expect(res.text).toContain('Leave Applications');
  });

  it('8. GET /admin/payroll renders faculty payroll console for admin', async () => {
    const adminPassword = process.env.ADMIN_PASSWORD || DEMO;
    const adminAgent = (await signIn(app, 'admin', adminPassword)).agent;
    const res = await adminAgent.get('/admin/payroll');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Faculty Payroll Administration');
    expect(res.text).toContain('Generate Monthly Payroll');
    expect(res.text).toContain('Payroll Records');
  });
});
