import { beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, signIn } from './helpers.js';

const DEMO=process.env.DEMO_PASSWORD??'';
const ADMIN=process.env.ADMIN_PASSWORD??'';
const {createApp}=hasAppEnv?await import('../../src/app.js'):{createApp:null};

describe.skipIf(!hasAppEnv)('T7 placement pages and permissions',()=>{
  const app=hasAppEnv?createApp!():null;
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
  });
  it('requires a session for student placement pages',async()=>{
    const {default:request}=await import('supertest');
    expect([302,401]).toContain((await request(app!).get('/student/placement')).status);
  });
});
