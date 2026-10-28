import { beforeAll, describe, expect, it } from 'vitest';
import { hasAdminEnv, signIn } from './helpers.js';

const DEMO=process.env.DEMO_PASSWORD??'';
const ADMIN=process.env.ADMIN_PASSWORD??'';
const {createApp}=hasAdminEnv?await import('../../src/app.js'):{createApp:null};
const {query}=hasAdminEnv?await import('../../src/db.js'):{query:null};

describe.skipIf(!hasAdminEnv)('T7 placement pages and permissions',()=>{
  const app=hasAdminEnv?createApp!():null;
  let student:Awaited<ReturnType<typeof signIn>>['agent'];
  let admin:Awaited<ReturnType<typeof signIn>>['agent'];
  beforeAll(async()=>{
    student=(await signIn(app!,'STU202600004',DEMO)).agent;
    admin=(await signIn(app!,'admin',ADMIN)).agent;
  });
  it('lets an authenticated student view their placement area',async()=>{
    expect((await student.get('/student/placement')).status).toBe(200);
    expect((await student.get('/student/placement/profile')).text).toContain('Placement profile');
    expect((await student.get('/student/placement/applications')).status).toBe(200);
  });
  it('keeps management routes admin-only and denies students',async()=>{
    expect((await student.get('/admin/placement')).status).toBe(403);
    expect((await student.get('/admin/placement/statistics')).status).toBe(403);
    expect((await student.get('/faculty/placement')).status).toBe(403);
    expect((await admin.get('/admin/placement')).status).toBe(200);
    expect((await admin.get('/admin/placement/companies')).status).toBe(200);
  });
  it('renders placement statistics including package and company offer summaries',async()=>{
    const response=await admin.get('/admin/placement/statistics');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Highest package');
    expect(response.text).toContain('Company-wise offers');
    expect(response.text).toContain('Active Students — Cohort Unverified');
    expect(response.text).toContain('Placement metrics and reporting limitations.');
    expect(response.text).toContain('Reporting scope: <strong>All branches (institution-wide)</strong>');
  });
  it('filters placement statistics by branch without changing route authorization',async()=>{
    const departments=await query!<{dept_id:string;dept_name:string}>(`SELECT dept_id,dept_name FROM department ORDER BY dept_id LIMIT 1`);
    const response=await admin.get(`/admin/placement/statistics?dept_id=${encodeURIComponent(departments[0]!.dept_id)}`);
    expect(response.status).toBe(200);
    expect(response.text).toContain(`<option value="${departments[0]!.dept_id}" selected>`);
    const escapedDepartmentName=departments[0]!.dept_name.replace(/&/g,'&amp;');
    expect(response.text).toContain(`Reporting scope: <strong>${escapedDepartmentName}</strong>`);
    expect((await student.get(`/admin/placement/statistics?dept_id=${encodeURIComponent(departments[0]!.dept_id)}`)).status).toBe(403);
  });
  it('rejects invalid branch filters instead of showing institution-wide statistics',async()=>{
    const invalidBranch=await admin.get('/admin/placement/statistics?dept_id=not-a-branch');
    expect(invalidBranch.status).toBe(400);
    expect(invalidBranch.text).toContain('Choose a valid branch.');
  });
  it('requires a session for student placement pages',async()=>{
    const {default:request}=await import('supertest');
    expect([302,401]).toContain((await request(app!).get('/student/placement')).status);
  });
});
