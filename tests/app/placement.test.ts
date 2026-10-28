import { beforeAll, describe, expect, it } from 'vitest';
import { csrfFrom, hasAdminEnv, signIn } from './helpers.js';

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
    expect(response.text).toContain('Unknown Expected Year (Branch)');
    expect(response.text).toContain('Placement metrics and reporting limitations.');
    expect(response.text).toContain('Reporting scope: <strong>All branches (institution-wide) · All batches</strong>');
  });
  it('filters placement statistics by branch without changing route authorization',async()=>{
    const departments=await query!<{dept_id:string;dept_name:string}>(`SELECT dept_id,dept_name FROM department ORDER BY dept_id LIMIT 1`);
    const response=await admin.get(`/admin/placement/statistics?dept_id=${encodeURIComponent(departments[0]!.dept_id)}`);
    expect(response.status).toBe(200);
    expect(response.text).toContain(`<option value="${departments[0]!.dept_id}" selected>`);
    const escapedDepartmentName=departments[0]!.dept_name.replace(/&/g,'&amp;');
    expect(response.text).toContain(`Reporting scope: <strong>${escapedDepartmentName} · All batches</strong>`);
    expect((await student.get(`/admin/placement/statistics?dept_id=${encodeURIComponent(departments[0]!.dept_id)}`)).status).toBe(403);
  });
  it('rejects invalid branch filters instead of showing institution-wide statistics',async()=>{
    const invalidBranch=await admin.get('/admin/placement/statistics?dept_id=not-a-branch');
    expect(invalidBranch.status).toBe(400);
    expect(invalidBranch.text).toContain('Choose a valid branch.');
  });
  it('does not let the general student editor bypass expected-year review',async()=>{
    const [record]=await query!<{
      student_id:number;first_name:string;middle_name:string|null;last_name:string;date_of_birth:string;gender:string;
      blood_group:string|null;category:string;status:string;email:string;personal_email:string|null;mobile_number:string;
      alternate_mobile:string|null;address:string|null;district_name:string|null;pincode:string|null;
      expected_graduation_year:number|null;
    }>(`SELECT s.student_id,s.first_name,s.middle_name,s.last_name,s.date_of_birth,s.gender,s.blood_group,s.category,s.status,s.email,
      s.personal_email,s.mobile_number,s.alternate_mobile,s.address,s.district_name,s.pincode,s.expected_graduation_year
      FROM student s WHERE s.student_number='STU202600004'`);
    if(!record)throw new Error('Expected the placement test student record.');
    const page=await admin.get(`/admin/students/${record.student_id}?edit=1`);
    const csrf=csrfFrom(page.text);
    const form={
      first_name:record.first_name,middle_name:record.middle_name??'',last_name:record.last_name,
      date_of_birth:record.date_of_birth,gender:record.gender,blood_group:record.blood_group??'',
      category:record.category,status:record.status,email:record.email,personal_email:record.personal_email??'',
      mobile_number:record.mobile_number,alternate_mobile:record.alternate_mobile??'',address:record.address??'',
      district_name:record.district_name??'',pincode:record.pincode?.trim()??'',
    };
    const save=(fields:Record<string,string>)=>admin.post(`/admin/students/${record.student_id}`)
      .type('form').send({_csrf:csrf,...fields});
    expect(page.text).not.toContain('name="expected_graduation_year"');
    expect(page.text).toContain('Verified expected passing-out year');
    const bypass=await save({...form,expected_graduation_year:'2099'});
    expect(bypass.status).toBe(302);
    expect((await admin.get(bypass.headers.location!)).text)
      .toContain('Verified passing-out years can only be changed through the expected-year review queue.');
    expect((await query!<{expected_graduation_year:number|null}>(`SELECT expected_graduation_year FROM student WHERE student_id=$1`,[record.student_id]))[0]?.expected_graduation_year)
      .toBe(record.expected_graduation_year);

    const studentPage=await student.get('/student/placement');
    const denied=await student.post(`/admin/students/${record.student_id}`).type('form')
      .send({_csrf:csrfFrom(studentPage.text),...form,expected_graduation_year:'2099'});
    expect(denied.status).toBe(403);
  });
  it('requires a session for student placement pages',async()=>{
    const {default:request}=await import('supertest');
    expect([302,401]).toContain((await request(app!).get('/student/placement')).status);
  });
});
