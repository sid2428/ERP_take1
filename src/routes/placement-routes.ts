import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, HttpError } from '../lib/http-error.js';
import { flash } from '../middleware/auth.js';
import { getAdminDrives, getAdminPlacementOverview, getCompanies, getDepartmentPlacementReport,
  getDriveApplicants, getPlacementDashboard, getPlacementProfile, getStudentApplications, getStudentDrives } from '../queries/placement-queries.js';

export const placementStudentRouter = Router();
const emptyToNull = z.preprocess((v) => v === '' ? null : v,
  z.string().url().max(500).refine(v => /^https?:\/\//i.test(v), 'Use an http or https URL.').nullable());
const dateTimeInput = z.preprocess((v) => {
  if (typeof v !== 'string' || !v || /(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return v;
  const normalized = v.length === 16 ? `${v}:00` : v;
  return `${normalized}+05:30`;
}, z.iso.datetime({ offset: true }));
const profileSchema = z.object({
  skills: z.string().trim().max(2000), resume_url: emptyToNull,
  linkedin_url: emptyToNull, github_url: emptyToNull, portfolio_url: emptyToNull,
});

placementStudentRouter.get('/', async (req, res) => {
  const studentId=req.user!.studentId!;
  const [summary,profile,status]=await Promise.all([
    getPlacementDashboard(studentId), getPlacementProfile(studentId),
    query(`SELECT * FROM v_student_placement_status WHERE student_id=$1`,[studentId]),
  ]);
  res.render('student/placement-dashboard',{title:'Placement',nav:'placement',summary,profile,status:status[0]});
});
placementStudentRouter.get('/profile',async(req,res)=>{
  const profile=await getPlacementProfile(req.user!.studentId!);
  res.render('student/placement-profile',{title:'Placement profile',nav:'placement',profile,errors:null});
});
placementStudentRouter.post('/profile',async(req,res)=>{
  const parsed=profileSchema.safeParse(req.body);
  if(!parsed.success){res.status(400).render('student/placement-profile',{title:'Placement profile',nav:'placement',profile:req.body,errors:parsed.error.issues.map(i=>i.message)});return;}
  const studentId=req.user!.studentId!;
  await transaction(async db=>{
    await db.query(`INSERT INTO student_placement_profile(student_id,skills,resume_url,linkedin_url,github_url,portfolio_url)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(student_id) DO UPDATE SET skills=EXCLUDED.skills,resume_url=EXCLUDED.resume_url,
      linkedin_url=EXCLUDED.linkedin_url,github_url=EXCLUDED.github_url,portfolio_url=EXCLUDED.portfolio_url,updated_at=now()`,
      [studentId,parsed.data.skills,...[parsed.data.resume_url,parsed.data.linkedin_url,parsed.data.github_url,parsed.data.portfolio_url].map(v=>v||null)]);
    await audit(req,{action:'PLACEMENT_PROFILE_UPDATE',entity:'student_placement_profile',entityId:studentId,details:{updated:true}},db);
  });
  flash(req,'success','Placement profile saved.');res.redirect('/student/placement/profile');
});
placementStudentRouter.get('/drives',async(req,res)=>{
  const filters={q:typeof req.query.q==='string'?req.query.q.slice(0,100):'',type:typeof req.query.type==='string'&&['FullTime','Internship'].includes(req.query.type)?req.query.type:'',eligible:typeof req.query.eligible==='string'&&['yes','no'].includes(req.query.eligible)?req.query.eligible:''};
  const drives=await getStudentDrives(req.user!.studentId!,filters);
  res.render('student/placement-drives',{title:'Placement drives',nav:'placement',drives,filters});
});
placementStudentRouter.get('/drives/:id',async(req,res)=>{
  const rows=await query(`SELECT d.*,c.company_name,c.industry,c.website_url,e.eligible,e.reasons,e.assessment_pending,
      COALESCE((SELECT json_agg(p.program_name ORDER BY p.program_name) FROM drive_program dp JOIN program p USING(program_id) WHERE dp.drive_id=d.drive_id),'[]'::json) AS programs
    FROM placement_drive d JOIN company c USING(company_id) CROSS JOIN LATERAL is_eligible($1,d.drive_id) e WHERE d.drive_id=$2`,[req.user!.studentId!,req.params.id]);
  if(!rows[0])throw notFound('Placement drive');
  const applied=await query(`SELECT application_id FROM placement_application WHERE student_id=$1 AND drive_id=$2`,[req.user!.studentId!,req.params.id]);
  res.render('student/placement-drive',{title:rows[0].title,nav:'placement',drive:rows[0],application:applied[0]});
});
placementStudentRouter.post('/drives/:id/apply',async(req,res)=>{
  const driveId=Number(req.params.id);if(!Number.isInteger(driveId))throw notFound('Placement drive');
  await transaction(async db=>{
    const ins=await db.query(`INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2) RETURNING application_id`,[req.user!.studentId!,driveId]);
    await audit(req,{action:'PLACEMENT_APPLY',entity:'placement_application',entityId:ins.rows[0].application_id,details:{drive_id:driveId}},db);
  });
  flash(req,'success','Your application was submitted.');res.redirect('/student/placement/applications');
});
placementStudentRouter.get('/applications',async(req,res)=>{
  const applications=await getStudentApplications(req.user!.studentId!);
  res.render('student/placement-applications',{title:'My applications',nav:'placement',applications});
});
placementStudentRouter.post('/applications/:id/withdraw',async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isInteger(id))throw notFound('Application');
  await transaction(async db=>{
    const result=await db.query(`UPDATE placement_application a SET status='Withdrawn',withdrawn_at=now(),withdrawal_reason=$3
      FROM placement_drive d WHERE a.application_id=$1 AND a.student_id=$2 AND a.drive_id=d.drive_id
        AND a.status IN ('Applied','Shortlisted') AND now()<d.deadline RETURNING a.application_id`,[id,req.user!.studentId!,String(req.body.reason??'').slice(0,500)||null]);
    if(!result.rowCount)throw new HttpError(400,'This application can no longer be withdrawn.');
    await audit(req,{action:'PLACEMENT_WITHDRAW',entity:'placement_application',entityId:id},db);
  });
  flash(req,'success','Application withdrawn.');res.redirect('/student/placement/applications');
});
placementStudentRouter.post('/offers/:id/respond',async(req,res)=>{
  const id=Number(req.params.id);const accept=req.body.response==='accept';
  if(!Number.isInteger(id)||!['accept','decline'].includes(req.body.response))throw new HttpError(400,'Choose accept or decline.');
  await transaction(async db=>{
    await db.query('SELECT respond_placement_offer($1,$2,$3)',[id,req.user!.studentId!,accept]);
    await audit(req,{action:accept?'PLACEMENT_OFFER_ACCEPT':'PLACEMENT_OFFER_DECLINE',entity:'placement_offer',entityId:id},db);
  });
  flash(req,'success',accept?'Offer accepted.':'Offer declined.');res.redirect('/student/placement/applications');
});

export const placementAdminRouter=Router();
const companySchema=z.object({company_name:z.string().trim().min(2).max(140),industry:z.string().trim().max(80),description:z.string().trim().max(3000),website_url:emptyToNull,contact_name:z.string().trim().max(100),contact_email:z.union([z.literal(''),z.email().max(120)]),contact_phone:z.string().trim().max(30),headquarters:z.string().trim().max(100)});
const nullableNumber = (min:number,max:number,integer=false) => z.preprocess(v=>v===''||v==null?null:Number(v),
  (integer?z.number().int():z.number()).min(min).max(max).nullable());
const driveSchema=z.object({company_id:z.coerce.number().int().positive(),title:z.string().trim().min(3).max(160),role_title:z.string().trim().min(2).max(120),drive_type:z.enum(['FullTime','Internship']),description:z.string().trim().max(5000),job_location:z.string().trim().max(120),package_lpa:z.preprocess(v=>v===''?undefined:v,z.coerce.number().nonnegative().max(999999).optional()),stipend_monthly:z.preprocess(v=>v===''?undefined:v,z.coerce.number().nonnegative().max(99999999).optional()),min_year:z.coerce.number().int().min(1).max(6),min_cgpa:nullableNumber(0,10),max_active_backlogs:nullableNumber(0,100,true),min_attendance_pct:nullableNumber(0,100),opens_at:dateTimeInput,deadline:dateTimeInput,drive_date:z.union([z.literal(''),z.iso.date()]),status:z.enum(['Draft','Open','Closed','Cancelled']),program_ids:z.string().max(500)}).refine(v=>v.drive_type==='FullTime'?v.package_lpa!==undefined&&v.stipend_monthly===undefined:v.stipend_monthly!==undefined&&v.package_lpa===undefined,{message:'Enter a package for full-time or monthly stipend for internship.'});
placementAdminRouter.get('/',async(_req,res)=>{
  const [overview,drives]=await Promise.all([getAdminPlacementOverview(),getAdminDrives()]);
  res.render('admin/placement-dashboard',{title:'Placement',nav:'placement',overview,drives});
});
placementAdminRouter.get('/companies',async(_req,res)=>res.render('admin/placement-companies',{title:'Companies',nav:'placement',companies:await getCompanies()}));
placementAdminRouter.post('/companies',async(req,res)=>{
  const p=companySchema.safeParse(req.body);if(!p.success)throw new HttpError(400,p.error.issues[0]?.message??'Invalid company.');
  const v=p.data;const id=await transaction(async db=>{const r=await db.query(`INSERT INTO company(company_name,industry,description,website_url,contact_name,contact_email,contact_phone,headquarters)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING company_id`,[v.company_name,v.industry||null,v.description||null,v.website_url,v.contact_name||null,v.contact_email||null,v.contact_phone||null,v.headquarters||null]);
    await audit(req,{action:'PLACEMENT_COMPANY_CREATE',entity:'company',entityId:r.rows[0].company_id},db);return r.rows[0].company_id;});
  flash(req,'success',`Company created (#${id}).`);res.redirect('/admin/placement/companies');
});
placementAdminRouter.get('/companies/:id',async(req,res)=>{
  const company=(await query(`SELECT * FROM company WHERE company_id=$1`,[req.params.id]))[0];if(!company)throw notFound('Company');
  res.render('admin/placement-company-edit',{title:'Edit company',nav:'placement',company});
});
placementAdminRouter.post('/companies/:id',async(req,res)=>{
  const p=companySchema.safeParse(req.body);if(!p.success)throw new HttpError(400,p.error.issues[0]?.message??'Invalid company.');const v=p.data,id=Number(req.params.id);
  await transaction(async db=>{const r=await db.query(`UPDATE company SET company_name=$2,industry=$3,description=$4,website_url=$5,contact_name=$6,contact_email=$7,contact_phone=$8,headquarters=$9 WHERE company_id=$1`,[id,v.company_name,v.industry||null,v.description||null,v.website_url,v.contact_name||null,v.contact_email||null,v.contact_phone||null,v.headquarters||null]);if(!r.rowCount)throw notFound('Company');await audit(req,{action:'PLACEMENT_COMPANY_UPDATE',entity:'company',entityId:id},db);});
  flash(req,'success','Company updated.');res.redirect('/admin/placement/companies');
});
placementAdminRouter.post('/companies/:id/toggle',async(req,res)=>{
  const id=Number(req.params.id);const row=await transaction(async db=>{const r=await db.query(`UPDATE company SET is_active=NOT is_active WHERE company_id=$1 RETURNING is_active`,[id]);if(!r.rowCount)throw notFound('Company');await audit(req,{action:'PLACEMENT_COMPANY_TOGGLE',entity:'company',entityId:id,details:{is_active:r.rows[0].is_active}},db);return r.rows[0];});
  flash(req,'success',row.is_active?'Company activated.':'Company deactivated.');res.redirect('/admin/placement/companies');
});
placementAdminRouter.get('/drives/new',async(_req,res)=>res.render('admin/placement-drive-form',{title:'Create drive',nav:'placement',companies:await query(`SELECT company_id,company_name FROM company WHERE is_active ORDER BY company_name`),programs:await query(`SELECT program_id,program_name FROM program WHERE is_active ORDER BY program_name`),errors:null,form:{}}));
placementAdminRouter.post('/drives',async(req,res)=>{
  const p=driveSchema.safeParse(req.body);if(!p.success){const [companies,programs]=await Promise.all([query(`SELECT company_id,company_name FROM company WHERE is_active ORDER BY company_name`),query(`SELECT program_id,program_name FROM program WHERE is_active ORDER BY program_name`)]);res.status(400).render('admin/placement-drive-form',{title:'Create drive',nav:'placement',companies,programs,errors:p.error.issues.map(i=>i.message),form:req.body});return;}
  const v=p.data,programIds=[...new Set(v.program_ids.split(',').map(x=>x.trim()).filter(Boolean))];
  if(programIds.some(x=>x.length>20))throw new HttpError(400,'Invalid program selection.');
  const id=await transaction(async db=>{
    const r=await db.query(`INSERT INTO placement_drive(company_id,title,role_title,drive_type,description,job_location,package_lpa,stipend_monthly,min_year,min_cgpa,max_active_backlogs,min_attendance_pct,opens_at,deadline,drive_date,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING drive_id`,
      [v.company_id,v.title,v.role_title,v.drive_type,v.description,v.job_location||null,v.package_lpa??null,v.stipend_monthly??null,v.min_year,v.min_cgpa,v.max_active_backlogs,v.min_attendance_pct,v.opens_at,v.deadline,v.drive_date||null,v.status,req.user!.userId]);
    const driveId=r.rows[0].drive_id;
    for(const programId of programIds)await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)',[driveId,programId]);
    if(v.status==='Open')await db.query('CALL notify_eligible_placement_drive($1)',[driveId]);
    await audit(req,{action:'PLACEMENT_DRIVE_CREATE',entity:'placement_drive',entityId:driveId,details:{programs:programIds.length}},db);return driveId;
  });
  flash(req,'success',`Drive created (#${id}).`);res.redirect(`/admin/placement/drives/${id}`);
});
placementAdminRouter.get('/drives/:id',async(req,res)=>{
  const id=Number(req.params.id);const drive=(await query(`SELECT d.*,c.company_name FROM placement_drive d JOIN company c USING(company_id) WHERE drive_id=$1`,[id]))[0];if(!drive)throw notFound('Placement drive');
  const [applicants,rounds]=await Promise.all([getDriveApplicants(id),query(`SELECT * FROM drive_round WHERE drive_id=$1 ORDER BY sequence_no`,[id])]);
  res.render('admin/placement-drive-detail',{title:drive.title,nav:'placement',drive,applicants,rounds});
});
placementAdminRouter.post('/drives/:id/status',async(req,res)=>{
  const status=z.enum(['Draft','Open','Closed','Cancelled']).parse(req.body.status);const id=Number(req.params.id);
  await transaction(async db=>{const r=await db.query(`UPDATE placement_drive SET status=$2 WHERE drive_id=$1 RETURNING drive_id`,[id,status]);if(!r.rowCount)throw notFound('Placement drive');if(status==='Open')await db.query('CALL notify_eligible_placement_drive($1)',[id]);await audit(req,{action:'PLACEMENT_DRIVE_STATUS',entity:'placement_drive',entityId:id,details:{status}},db);});
  flash(req,'success',`Drive ${status.toLowerCase()}.`);res.redirect(`/admin/placement/drives/${id}`);
});
placementAdminRouter.post('/drives/:id/rounds',async(req,res)=>{
  const p=z.object({sequence_no:z.coerce.number().int().min(1).max(20),round_name:z.string().trim().min(2).max(100),description:z.string().trim().max(1000),scheduled_at:z.preprocess(v=>v===''?undefined:v,dateTimeInput.optional())}).safeParse(req.body);if(!p.success)throw new HttpError(400,'Check the round details.');
  const id=Number(req.params.id);await transaction(async db=>{const r=await db.query(`INSERT INTO drive_round(drive_id,sequence_no,round_name,description,scheduled_at) VALUES($1,$2,$3,$4,$5) RETURNING round_id`,[id,p.data.sequence_no,p.data.round_name,p.data.description||null,p.data.scheduled_at||null]);await audit(req,{action:'PLACEMENT_ROUND_CREATE',entity:'drive_round',entityId:r.rows[0].round_id},db);});flash(req,'success','Round added.');res.redirect(`/admin/placement/drives/${id}`);
});
placementAdminRouter.post('/applications/:id/status',async(req,res)=>{
  const status=z.enum(['Shortlisted','Selected','Rejected']).parse(req.body.status);const id=Number(req.params.id);const row=await transaction(async db=>{const r=await db.query(`UPDATE placement_application SET status=$2,updated_at=now() WHERE application_id=$1 RETURNING drive_id`,[id,status]);if(!r.rowCount)throw notFound('Application');await audit(req,{action:'PLACEMENT_APPLICATION_STATUS',entity:'placement_application',entityId:id,details:{status}},db);return r.rows[0];});flash(req,'success',`Application marked ${status.toLowerCase()}.`);res.redirect(`/admin/placement/drives/${row.drive_id}`);
});
placementAdminRouter.post('/applications/:id/results',async(req,res)=>{
  const p=z.object({round_id:z.coerce.number().int().positive(),result:z.enum(['Pending','Passed','Failed','OnHold']),private_remarks:z.string().trim().max(1000)}).parse(req.body);const id=Number(req.params.id);
  const driveId=await transaction(async db=>{const app=await db.query(`SELECT drive_id FROM placement_application WHERE application_id=$1`,[id]);if(!app.rowCount)throw notFound('Application');await db.query(`INSERT INTO round_result(drive_id,application_id,round_id,result,private_remarks) VALUES($1,$2,$3,$4,$5) ON CONFLICT(application_id,round_id) DO UPDATE SET result=EXCLUDED.result,private_remarks=EXCLUDED.private_remarks,result_at=now()`,[app.rows[0].drive_id,id,p.round_id,p.result,p.private_remarks||null]);await audit(req,{action:'PLACEMENT_ROUND_RESULT',entity:'placement_application',entityId:id,details:{round_id:p.round_id,result:p.result}},db);return app.rows[0].drive_id;});flash(req,'success','Round result saved.');res.redirect(`/admin/placement/drives/${driveId}`);
});
placementAdminRouter.post('/applications/:id/offers',async(req,res)=>{
  const p=z.object({package_lpa:nullableNumber(0,999999),stipend_monthly:nullableNumber(0,99999999),response_deadline:dateTimeInput,joining_date:z.union([z.literal(''),z.iso.date()])}).refine(v=>(v.package_lpa===null)!==(v.stipend_monthly===null)).parse(req.body);const id=Number(req.params.id);
  const driveId=await transaction(async db=>{const app=await db.query(`SELECT drive_id FROM placement_application WHERE application_id=$1`,[id]);if(!app.rowCount)throw notFound('Application');const r=await db.query(`INSERT INTO placement_offer(application_id,package_lpa,stipend_monthly,response_deadline,joining_date) VALUES($1,$2,$3,$4,$5) RETURNING offer_id`,[id,p.package_lpa,p.stipend_monthly,p.response_deadline,p.joining_date||null]);await audit(req,{action:'PLACEMENT_OFFER_CREATE',entity:'placement_offer',entityId:r.rows[0].offer_id},db);return app.rows[0].drive_id;});flash(req,'success','Offer recorded.');res.redirect(`/admin/placement/drives/${driveId}`);
});
placementAdminRouter.get('/drives/:id/applicants.csv',async(req,res)=>{
  const driveId=Number(req.params.id);const rows=await query(`SELECT s.student_number,s.first_name,s.last_name,p.program_name,a.status,a.applied_at FROM placement_application a JOIN student s USING(student_id) JOIN program p USING(program_id) WHERE a.drive_id=$1 ORDER BY a.applied_at`,[driveId]);
  const cell=(v:unknown)=>{let s=String(v??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return `"${s.replace(/"/g,'""')}"`;};
  res.type('text/csv').attachment(`placement-applicants-${driveId}.csv`).send(['Student number,First name,Last name,Program,Status,Applied at',...rows.map(r=>[r.student_number,r.first_name,r.last_name,r.program_name,r.status,r.applied_at].map(cell).join(','))].join('\r\n'));
});
placementAdminRouter.get('/statistics',async(_req,res)=>{
  const byDepartment=await query(`SELECT d.dept_name,count(DISTINCT s.student_id)::int AS active_students,count(DISTINCT s.student_id) FILTER(WHERE ps.is_placed)::int AS placed_students,round(100.0*count(DISTINCT s.student_id) FILTER(WHERE ps.is_placed)/NULLIF(count(DISTINCT s.student_id),0),2) AS placed_pct,max(ps.best_offer_lpa) AS highest_package_lpa FROM department d JOIN program p USING(dept_id) JOIN student s USING(program_id) JOIN v_student_placement_status ps USING(student_id) WHERE s.status='Active' GROUP BY d.dept_name ORDER BY d.dept_name`);
  const overview=await getAdminPlacementOverview();res.render('admin/placement-statistics',{title:'Placement statistics',nav:'placement',overview,byDepartment});
});

export const placementFacultyRouter=Router();
placementFacultyRouter.get('/placement',async(req,res)=>{
  const isHod=await query(`SELECT 1 FROM department WHERE hod_faculty_id=$1 AND dept_id=$2`,[req.user!.facultyId,req.user!.deptId]);if(!isHod.length)throw forbidden();
  res.render('faculty/placement-report',{title:'Department placement report',nav:'placement',rows:await getDepartmentPlacementReport(req.user!.deptId!)});
});
