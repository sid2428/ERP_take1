import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { csrfFrom, hasAppEnv, signIn } from './helpers.js';

const enabled=hasAppEnv&&Boolean(process.env.ADMIN_PASSWORD);
const {createApp}=enabled?await import('../../src/app.js'):{createApp:null};
const {pool}=enabled?await import('../../src/db.js'):{pool:null};
type Agent=Awaited<ReturnType<typeof signIn>>['agent'];
type Fixture={driveId:number;companyId:number;programId:string;year:number;studentId:number};

describe.skipIf(!enabled)('T7 placement workflows',()=>{
  const app:Express=enabled?createApp!():null as never;
  let student:Agent;
  let admin:Agent;
  let studentId:number;
  let programId:string;
  let year:number;

  beforeAll(async()=>{
    student=(await signIn(app,'STU202600004',process.env.DEMO_PASSWORD??'')).agent;
    admin=(await signIn(app,'admin',process.env.ADMIN_PASSWORD??'')).agent;
    const result=await pool!.query(`SELECT s.student_id,s.program_id,d.year_of_study FROM app_user u JOIN student s USING(student_id)
      JOIN student_section ss ON ss.student_id=s.student_id AND ss.academic_session_id=current_session_id()
      JOIN division d USING(division_id) WHERE u.login_id=$1`,['STU202600004']);
    if(!result.rows[0])throw new Error('Placement test student must have a current academic section.');
    studentId=result.rows[0].student_id;programId=result.rows[0].program_id;year=result.rows[0].year_of_study;
  });

  afterAll(async()=>{await pool?.end();});

  async function fixture(options:{status?:'Draft'|'Open';programMismatch?:boolean}={}):Promise<Fixture>{
    const company=await pool!.query(`INSERT INTO company(company_name) VALUES($1) RETURNING company_id`,[`placement-workflow-${randomUUID()}`]);
    const companyId=company.rows[0].company_id as number;
    const drive=await pool!.query(`INSERT INTO placement_drive(company_id,title,role_title,drive_type,package_lpa,min_year,opens_at,deadline,status)
      VALUES($1,$2,'Engineer','FullTime',10,$3,now()-interval '1 hour',now()+interval '2 days',$4) RETURNING drive_id`,
      [companyId,`workflow-${randomUUID()}`,year,options.status??'Draft']);
    const driveId=drive.rows[0].drive_id as number;
    let selectedProgram=programId;
    if(options.programMismatch){
      const other=await pool!.query(`SELECT program_id FROM program WHERE program_id<>$1 AND is_active ORDER BY program_id LIMIT 1`,[programId]);
      if(!other.rows[0])throw new Error('Placement tests require at least two active programs.');
      selectedProgram=other.rows[0].program_id;
    }
    await pool!.query(`INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)`,[driveId,selectedProgram]);
    return {driveId,companyId,programId:selectedProgram,year,studentId};
  }

  async function dispose(f:Fixture){
    await pool!.query(`DELETE FROM placement_offer WHERE application_id IN (SELECT application_id FROM placement_application WHERE drive_id=$1)`,[f.driveId]);
    await pool!.query(`DELETE FROM round_result WHERE drive_id=$1`,[f.driveId]);
    await pool!.query(`DELETE FROM placement_application WHERE drive_id=$1`,[f.driveId]);
    await pool!.query(`DELETE FROM drive_round WHERE drive_id=$1`,[f.driveId]);
    await pool!.query(`DELETE FROM placement_drive WHERE drive_id=$1`,[f.driveId]);
    await pool!.query(`DELETE FROM company WHERE company_id=$1`,[f.companyId]);
  }

  async function submit(agent:Agent,page:string,path:string,fields:Record<string,string>){
    const form=await agent.get(page);
    return agent.post(path).type('form').send({_csrf:csrfFrom(form.text),...fields}).set('Accept','application/json');
  }

  it('allows an eligible student to apply, rejects duplicates, and shows their own application history',async()=>{
    const f=await fixture({status:'Open'});
    try{
      const first=await submit(student,`/student/placement/drives/${f.driveId}`,`/student/placement/drives/${f.driveId}/apply`,{});
      expect(first.status).toBe(302);
      const duplicate=await submit(student,`/student/placement/drives/${f.driveId}`,`/student/placement/drives/${f.driveId}/apply`,{});
      expect(duplicate.status).toBe(400);
      const history=await student.get('/student/placement/applications');
      expect(history.status).toBe(200);
      expect(history.text).toContain('Applied');
      const adminPage=await admin.get(`/admin/placement/drives/${f.driveId}`);
      const csrf=csrfFrom(adminPage.text);
      const application=await pool!.query(`SELECT application_id FROM placement_application WHERE student_id=$1 AND drive_id=$2`,[studentId,f.driveId]);
      const applicationId=application.rows[0].application_id as number;
      const invalidStage=await admin.post(`/admin/placement/applications/${applicationId}/status`).type('form').send({_csrf:csrf,status:'Selected'}).set('Accept','application/json');
      expect(invalidStage.status).toBe(409);
      const shortlisted=await admin.post(`/admin/placement/applications/${applicationId}/status`).type('form').send({_csrf:csrf,status:'Shortlisted'});
      expect(shortlisted.status).toBe(302);
      const selected=await admin.post(`/admin/placement/applications/${applicationId}/status`).type('form').send({_csrf:csrf,status:'Selected'});
      expect(selected.status).toBe(302);
      const expiredOffer=await admin.post(`/admin/placement/applications/${applicationId}/offers`).type('form').send({_csrf:csrf,package_lpa:'10',stipend_monthly:'',response_deadline:new Date(Date.now()-60_000).toISOString(),joining_date:''}).set('Accept','application/json');
      expect(expiredOffer.status).toBe(400);

      const roundAdded=await admin.post(`/admin/placement/drives/${f.driveId}/rounds`).type('form').send({_csrf:csrf,sequence_no:'1',round_name:'Results round',description:'',scheduled_at:''});
      expect(roundAdded.status).toBe(302);
      const round=await pool!.query(`SELECT round_id FROM drive_round WHERE drive_id=$1`,[f.driveId]);
      const result=await admin.post(`/admin/placement/applications/${applicationId}/results`).type('form').send({_csrf:csrf,round_id:String(round.rows[0].round_id),result:'Passed',private_remarks:''});
      expect(result.status).toBe(302);

      const offered=await admin.post(`/admin/placement/applications/${applicationId}/offers`).type('form').send({_csrf:csrf,package_lpa:'10',stipend_monthly:'',response_deadline:new Date(Date.now()+86400000).toISOString(),joining_date:''});
      expect(offered.status).toBe(302);
      const pending=await student.get('/student/placement/applications');
      expect(pending.text).toContain('Results round');
      expect(pending.text).toContain('Pending');
      const offer=await pool!.query(`SELECT offer_id FROM placement_offer WHERE application_id=$1`,[applicationId]);
      const response=await student.post(`/student/placement/offers/${offer.rows[0].offer_id}/respond`).type('form').send({_csrf:csrfFrom(pending.text),response:'accept'});
      expect(response.status).toBe(302);
      const accepted=await pool!.query(`SELECT status FROM placement_offer WHERE offer_id=$1`,[offer.rows[0].offer_id]);
      expect(accepted.rows[0].status).toBe('Accepted');
      expect(history.text).toContain(`workflow-`);
    }finally{await dispose(f);}
  });

  it('saves a student placement profile and restores the prior profile after the test',async()=>{
    const before=await pool!.query(`SELECT skills,resume_url,linkedin_url,github_url,portfolio_url,updated_at FROM student_placement_profile WHERE student_id=$1`,[studentId]);
    const marker=`tnp-profile-${randomUUID()}`;
    try{
      const page=await student.get('/student/placement/profile');
      const saved=await student.post('/student/placement/profile').type('form').send({_csrf:csrfFrom(page.text),skills:marker,resume_url:'https://example.test/resume',linkedin_url:'',github_url:'',portfolio_url:''});
      expect(saved.status).toBe(302);
      const refreshed=await student.get('/student/placement/profile');
      expect(refreshed.status).toBe(200);
      expect(refreshed.text).toContain(marker);
      const row=await pool!.query(`SELECT skills,resume_url FROM student_placement_profile WHERE student_id=$1`,[studentId]);
      expect(row.rows[0]).toMatchObject({skills:marker,resume_url:'https://example.test/resume'});
    }finally{
      if(before.rows[0]){
        await pool!.query(`UPDATE student_placement_profile SET skills=$2,resume_url=$3,linkedin_url=$4,github_url=$5,portfolio_url=$6,updated_at=$7 WHERE student_id=$1`,[studentId,before.rows[0].skills,before.rows[0].resume_url,before.rows[0].linkedin_url,before.rows[0].portfolio_url,before.rows[0].updated_at]);
      }else await pool!.query(`DELETE FROM student_placement_profile WHERE student_id=$1`,[studentId]);
    }
  });

  it('allows a student to withdraw their own application before the deadline',async()=>{
    const f=await fixture({status:'Open'});
    try{
      const submitted=await submit(student,`/student/placement/drives/${f.driveId}`,`/student/placement/drives/${f.driveId}/apply`,{});
      expect(submitted.status).toBe(302);
      const application=await pool!.query(`SELECT application_id FROM placement_application WHERE student_id=$1 AND drive_id=$2`,[studentId,f.driveId]);
      const history=await student.get('/student/placement/applications');
      const withdrawn=await student.post(`/student/placement/applications/${application.rows[0].application_id}/withdraw`).type('form').send({_csrf:csrfFrom(history.text),reason:'Local TNP workflow verification'});
      expect(withdrawn.status).toBe(302);
      const saved=await pool!.query(`SELECT status,withdrawn_at FROM placement_application WHERE application_id=$1`,[application.rows[0].application_id]);
      expect(saved.rows[0].status).toBe('Withdrawn');
      expect(saved.rows[0].withdrawn_at).not.toBeNull();
      expect((await student.get('/student/placement/applications')).text).toContain('Withdrawn');
    }finally{await dispose(f);}
  });

  it('blocks an ineligible student at the application endpoint',async()=>{
    const f=await fixture({status:'Open',programMismatch:true});
    try{
      const response=await submit(student,`/student/placement/drives/${f.driveId}`,`/student/placement/drives/${f.driveId}/apply`,{});
      expect(response.status).toBe(400);
      const count=await pool!.query(`SELECT count(*)::int AS count FROM placement_application WHERE student_id=$1 AND drive_id=$2`,[studentId,f.driveId]);
      expect(count.rows[0].count).toBe(0);
    }finally{await dispose(f);}
  });

  it('hides draft and cancelled drive details from students',async()=>{
    const f=await fixture();
    try{
      expect((await student.get(`/student/placement/drives/${f.driveId}`)).status).toBe(404);
      await pool!.query(`UPDATE placement_drive SET status='Cancelled' WHERE drive_id=$1`,[f.driveId]);
      expect((await student.get(`/student/placement/drives/${f.driveId}`)).status).toBe(404);
    }finally{await dispose(f);}
  });

  it('lets an admin edit an unpublished drive, then locks its details after an application',async()=>{
    const f=await fixture();
    try{
      const editPage=await admin.get(`/admin/placement/drives/${f.driveId}/edit`);
      expect(editPage.status).toBe(200);
      const csrf=csrfFrom(editPage.text);
      const invalid=await admin.post(`/admin/placement/drives/${f.driveId}/edit`).type('form').send({_csrf:csrf,company_id:String(f.companyId),title:'Invalid deadline',role_title:'Engineer',drive_type:'FullTime',description:'',job_location:'',package_lpa:'12',stipend_monthly:'',min_year:String(year),min_cgpa:'',max_active_backlogs:'',min_attendance_pct:'',opens_at:new Date(Date.now()+3600000).toISOString(),deadline:new Date(Date.now()+1800000).toISOString(),drive_date:'',program_ids:programId}).set('Accept','application/json');
      expect(invalid.status).toBe(400);
      const opensAt=new Date(Date.now()-3600000).toISOString();
      const saved=await admin.post(`/admin/placement/drives/${f.driveId}/edit`).type('form').send({_csrf:csrf,company_id:String(f.companyId),title:'Edited placement role',role_title:'Engineer',drive_type:'FullTime',description:'Updated description',job_location:'Pune',package_lpa:'12',stipend_monthly:'',min_year:String(year),min_cgpa:'9.5',max_active_backlogs:'',min_attendance_pct:'',opens_at:opensAt,deadline:new Date(Date.now()+86400000).toISOString(),drive_date:'',program_ids:programId});
      expect(saved.status).toBe(302);
      const data=await pool!.query(`SELECT title,package_lpa FROM placement_drive WHERE drive_id=$1`,[f.driveId]);
      expect(data.rows[0]).toMatchObject({title:'Edited placement role',package_lpa:12});

      const detail=await admin.get(`/admin/placement/drives/${f.driveId}`);
      const published=await admin.post(`/admin/placement/drives/${f.driveId}/status`).type('form').send({_csrf:csrfFrom(detail.text),status:'Open'});
      expect(published.status).toBe(302);
      expect((await admin.get(`/admin/placement/drives/${f.driveId}/edit`)).status).toBe(409);
      await pool!.query(`UPDATE placement_drive SET min_cgpa=NULL WHERE drive_id=$1`,[f.driveId]);
      await submit(student,`/student/placement/drives/${f.driveId}`,`/student/placement/drives/${f.driveId}/apply`,{});
      const locked=await admin.post(`/admin/placement/drives/${f.driveId}/edit`).type('form').send({_csrf:csrf,company_id:String(f.companyId),title:'Changed again',role_title:'Engineer',drive_type:'FullTime',description:'',job_location:'',package_lpa:'12',stipend_monthly:'',min_year:String(year),min_cgpa:'',max_active_backlogs:'',min_attendance_pct:'',opens_at:new Date(Date.now()-3600000).toISOString(),deadline:new Date(Date.now()+86400000).toISOString(),drive_date:'',program_ids:programId}).set('Accept','application/json');
      expect(locked.status).toBe(409);
    }finally{await dispose(f);}
  });

  it('creates a draft drive for an active company and rejects inactive companies or programs',async()=>{
    const f=await fixture();
    let createdId:number|undefined;
    const marker=`created-workflow-${randomUUID()}`;
    try{
      const form=await admin.get('/admin/placement/drives/new');
      expect(form.status).toBe(200);
      const csrf=csrfFrom(form.text);
      const fields={_csrf:csrf,company_id:String(f.companyId),title:marker,role_title:'Graduate Engineer',drive_type:'FullTime',description:'Created through the admin route',job_location:'Pune',package_lpa:'11',stipend_monthly:'',min_year:String(year),min_cgpa:'',max_active_backlogs:'',min_attendance_pct:'',opens_at:new Date(Date.now()-3600000).toISOString(),deadline:new Date(Date.now()+86400000).toISOString(),drive_date:'',status:'Draft',program_ids:f.programId};
      const created=await admin.post('/admin/placement/drives').type('form').send(fields);
      expect(created.status).toBe(302);
      const saved=await pool!.query(`SELECT drive_id,status,title FROM placement_drive WHERE title=$1`,[marker]);
      expect(saved.rows).toHaveLength(1);
      createdId=saved.rows[0].drive_id as number;
      expect(saved.rows[0]).toMatchObject({status:'Draft',title:marker});
      const programs=await pool!.query(`SELECT program_id FROM drive_program WHERE drive_id=$1`,[createdId]);
      expect(programs.rows.map(row=>row.program_id)).toEqual([f.programId]);

      await pool!.query(`UPDATE company SET is_active=false WHERE company_id=$1`,[f.companyId]);
      const inactiveCompany=await admin.post('/admin/placement/drives').type('form').send({...fields,title:`${marker}-inactive-company`}).set('Accept','application/json');
      expect(inactiveCompany.status).toBe(400);
      await pool!.query(`UPDATE company SET is_active=true WHERE company_id=$1`,[f.companyId]);
      const invalidProgram=await admin.post('/admin/placement/drives').type('form').send({...fields,title:`${marker}-invalid-program`,program_ids:'NO_SUCH_PROGRAM'}).set('Accept','application/json');
      expect(invalidProgram.status).toBe(400);
      const rejected=await pool!.query(`SELECT count(*)::int AS count FROM placement_drive WHERE title LIKE $1`,[`${marker}-%`]);
      expect(rejected.rows[0].count).toBe(0);
    }finally{
      if(createdId)await pool!.query(`DELETE FROM placement_drive WHERE drive_id=$1`,[createdId]);
      await pool!.query(`UPDATE company SET is_active=true WHERE company_id=$1`,[f.companyId]);
      await dispose(f);
    }
  });

  it('allows a student to decline their own offer and records the response',async()=>{
    const f=await fixture({status:'Open'});
    try{
      const applied=await submit(student,`/student/placement/drives/${f.driveId}`,`/student/placement/drives/${f.driveId}/apply`,{});
      expect(applied.status).toBe(302);
      const application=await pool!.query(`SELECT application_id FROM placement_application WHERE student_id=$1 AND drive_id=$2`,[studentId,f.driveId]);
      const applicationId=application.rows[0].application_id as number;
      const adminPage=await admin.get(`/admin/placement/drives/${f.driveId}`);
      const csrf=csrfFrom(adminPage.text);
      await admin.post(`/admin/placement/applications/${applicationId}/status`).type('form').send({_csrf:csrf,status:'Shortlisted'});
      await admin.post(`/admin/placement/applications/${applicationId}/status`).type('form').send({_csrf:csrf,status:'Selected'});
      const offerResponse=await admin.post(`/admin/placement/applications/${applicationId}/offers`).type('form').send({_csrf:csrf,package_lpa:'10',stipend_monthly:'',response_deadline:new Date(Date.now()+86400000).toISOString(),joining_date:''});
      expect(offerResponse.status).toBe(302);
      const offer=await pool!.query(`SELECT offer_id FROM placement_offer WHERE application_id=$1`,[applicationId]);
      const history=await student.get('/student/placement/applications');
      const declined=await student.post(`/student/placement/offers/${offer.rows[0].offer_id}/respond`).type('form').send({_csrf:csrfFrom(history.text),response:'decline'});
      expect(declined.status).toBe(302);
      const saved=await pool!.query(`SELECT status,responded_at FROM placement_offer WHERE offer_id=$1`,[offer.rows[0].offer_id]);
      expect(saved.rows[0].status).toBe('Declined');
      expect(saved.rows[0].responded_at).not.toBeNull();
      expect((await student.get('/student/placement/applications')).text).toContain('Declined');
      const company=await pool!.query(`SELECT company_name FROM company WHERE company_id=$1`,[f.companyId]);
      const statistics=await admin.get('/admin/placement/statistics');
      expect(statistics.text).toContain(company.rows[0].company_name);
    }finally{await dispose(f);}
  });

  it('allows admins to schedule rounds and enforces round state transitions',async()=>{
    const f=await fixture();
    try{
      const page=await admin.get(`/admin/placement/drives/${f.driveId}`);
      const csrf=csrfFrom(page.text);
      const created=await admin.post(`/admin/placement/drives/${f.driveId}/rounds`).type('form').send({_csrf:csrf,sequence_no:'1',round_name:'Technical',description:'',scheduled_at:new Date(Date.now()+3600000).toISOString()});
      expect(created.status).toBe(302);
      const round=await pool!.query(`SELECT round_id FROM drive_round WHERE drive_id=$1`,[f.driveId]);
      const roundId=round.rows[0].round_id as number;
      const rescheduled=await admin.post(`/admin/placement/drives/${f.driveId}/rounds/${roundId}/edit`).type('form').send({_csrf:csrf,round_name:'Technical interview',description:'Updated schedule',scheduled_at:new Date(Date.now()+7200000).toISOString()});
      expect(rescheduled.status).toBe(302);
      const schedule=await pool!.query(`SELECT round_name,description FROM drive_round WHERE round_id=$1`,[roundId]);
      expect(schedule.rows[0]).toMatchObject({round_name:'Technical interview',description:'Updated schedule'});
      const pastSchedule=await admin.post(`/admin/placement/drives/${f.driveId}/rounds/${roundId}/edit`).type('form').send({_csrf:csrf,round_name:'Technical interview',description:'',scheduled_at:new Date(Date.now()-3600000).toISOString()}).set('Accept','application/json');
      expect(pastSchedule.status).toBe(400);
      const tooEarly=await admin.post(`/admin/placement/drives/${f.driveId}/rounds/${roundId}/status`).type('form').send({_csrf:csrf,status:'InProgress'}).set('Accept','application/json');
      expect(tooEarly.status).toBe(409);
      await pool!.query(`UPDATE drive_round SET scheduled_at=NULL WHERE round_id=$1`,[roundId]);
      const started=await admin.post(`/admin/placement/drives/${f.driveId}/rounds/${roundId}/status`).type('form').send({_csrf:csrf,status:'InProgress'});
      expect(started.status).toBe(302);
      const completed=await admin.post(`/admin/placement/drives/${f.driveId}/rounds/${roundId}/status`).type('form').send({_csrf:csrf,status:'Completed'});
      expect(completed.status).toBe(302);
      const invalid=await admin.post(`/admin/placement/drives/${f.driveId}/rounds/${roundId}/status`).type('form').send({_csrf:csrf,status:'Cancelled'}).set('Accept','application/json');
      expect(invalid.status).toBe(409);
    }finally{await dispose(f);}
  });

  it('denies students access to drive editing and round management',async()=>{
    const f=await fixture();
    try{
      expect((await student.get(`/admin/placement/drives/${f.driveId}/edit`)).status).toBe(403);
      const round=await pool!.query(`INSERT INTO drive_round(drive_id,sequence_no,round_name) VALUES($1,1,'Technical') RETURNING round_id`,[f.driveId]);
      const page=await student.get(`/student/placement`);
      expect((await student.post('/admin/placement/drives').type('form').send({_csrf:csrfFrom(page.text),title:'Unauthorized drive'})).status).toBe(403);
      expect((await student.post(`/admin/placement/drives/${f.driveId}/edit`).type('form').send({_csrf:csrfFrom(page.text)})).status).toBe(403);
      expect((await student.post(`/admin/placement/drives/${f.driveId}/rounds/${round.rows[0].round_id}/status`).type('form').send({_csrf:csrfFrom(page.text),status:'Cancelled'})).status).toBe(403);
    }finally{await dispose(f);}
  });
});
