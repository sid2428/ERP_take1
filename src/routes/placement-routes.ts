import { Router } from 'express';
import { z } from 'zod';
import { friendlyDbError, query, transaction } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, HttpError } from '../lib/http-error.js';
import { flash } from '../middleware/auth.js';
import { parsePlacementDrivePagination } from '../lib/placement-pagination.js';
import { escapeCsvCell } from '../lib/csv.js';
import { chartBarPercent, placementPercentage } from '../lib/placement-stats.js';
import { getAdminBatchPlacementStats, getAdminDepartmentPlacementStats, getAdminDrives, getAdminExpectedGraduationYears,
  getAdminPlacementOverview, getCompanies, getDepartmentPlacementReport,
  getAcceptedFullTimePackageDistribution, getCompanyPlacementOffers, getDriveApplicants, getPlacementDashboard,
  getPlacementProfile, getStudentApplications, getStudentDrives } from '../queries/placement-queries.js';

export const placementStudentRouter = Router();
const emptyToNull = z.preprocess((v) => v === '' ? null : v,
  z.string().url().max(500).refine(v => /^https?:\/\//i.test(v), 'Use an http or https URL.').nullable());
const dateTimeInput = z.preprocess((v) => {
  if (typeof v !== 'string' || !v || /(?:Z|[+-]\d{2}:\d{2})$/.test(v)) return v;
  const normalized = v.length === 16 ? `${v}:00` : v;
  return `${normalized}+05:30`;
}, z.iso.datetime({ offset: true }));
const submittedExpectedGraduationYearSchema = z.preprocess(
  (value) => value === '' ? null : value,
  z.union([
    z.null(),
    z.string()
      .regex(/^\d{4}$/, 'Expected passing-out year must be a four-digit year.')
      .transform(Number)
      .refine((year) => year >= 2000 && year <= 2100,
        'Expected passing-out year must be between 2000 and 2100.'),
  ]),
);
const profileSchema = z.object({
  skills: z.string().trim().max(2000), resume_url: emptyToNull,
  linkedin_url: emptyToNull, github_url: emptyToNull, portfolio_url: emptyToNull,
  submitted_expected_graduation_year: submittedExpectedGraduationYearSchema.optional(),
});
const applicationTransitions:Record<string,string[]>={Applied:['Shortlisted','Rejected'],Shortlisted:['Selected','Rejected'],Selected:['Rejected'],Rejected:[],Withdrawn:[]};

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
    if(parsed.data.submitted_expected_graduation_year!==undefined){
      await db.query(`UPDATE student SET submitted_expected_graduation_year=$2 WHERE student_id=$1`,
        [studentId,parsed.data.submitted_expected_graduation_year]);
    }
    await audit(req,{action:'PLACEMENT_PROFILE_UPDATE',entity:'student_placement_profile',entityId:studentId,
      details:{updated:true,submitted_expected_graduation_year:parsed.data.submitted_expected_graduation_year}},db);
  });
  flash(req,'success','Placement profile saved.');res.redirect('/student/placement/profile');
});
placementStudentRouter.get('/drives',async(req,res)=>{
  const filters={q:typeof req.query.q==='string'?req.query.q.slice(0,100):'',type:typeof req.query.type==='string'&&['FullTime','Internship'].includes(req.query.type)?req.query.type:'',eligible:typeof req.query.eligible==='string'&&['yes','no'].includes(req.query.eligible)?req.query.eligible:''};
  const pagination=parsePlacementDrivePagination(req.query.page,req.query.page_size);
  const result=await getStudentDrives(req.user!.studentId!,filters,pagination);
  res.render('student/placement-drives',{title:'Placement drives',nav:'placement',...result,filters});
});
placementStudentRouter.get('/drives/:id',async(req,res)=>{
  const driveId=Number(req.params.id);if(!Number.isInteger(driveId)||driveId<1)throw notFound('Placement drive');
  const rows=await query(`SELECT d.*,c.company_name,c.industry,c.website_url,e.eligible,e.reasons,e.assessment_pending,
      COALESCE((SELECT json_agg(p.program_name ORDER BY p.program_name) FROM drive_program dp JOIN program p USING(program_id) WHERE dp.drive_id=d.drive_id),'[]'::json) AS programs
    FROM placement_drive d JOIN company c USING(company_id) CROSS JOIN LATERAL is_eligible($1,d.drive_id) e WHERE d.drive_id=$2 AND d.status IN ('Open','Closed')`,[req.user!.studentId!,driveId]);
  if(!rows[0])throw notFound('Placement drive');
  const applied=await query(`SELECT application_id FROM placement_application WHERE student_id=$1 AND drive_id=$2`,[req.user!.studentId!,req.params.id]);
  res.render('student/placement-drive',{title:rows[0].title,nav:'placement',drive:rows[0],application:applied[0]});
});
placementStudentRouter.post('/drives/:id/apply',async(req,res)=>{
  const driveId=Number(req.params.id);if(!Number.isInteger(driveId))throw notFound('Placement drive');
  try {
    await transaction(async db=>{
      const ins=await db.query(`INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2) RETURNING application_id`,[req.user!.studentId!,driveId]);
      await audit(req,{action:'PLACEMENT_APPLY',entity:'placement_application',entityId:ins.rows[0].application_id,details:{drive_id:driveId}},db);
    });
  } catch (err) {
    const message=friendlyDbError(err);
    if(message)throw new HttpError(400,message);
    throw err;
  }
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
  try {
    await transaction(async db=>{
      await db.query('SELECT respond_placement_offer($1,$2,$3)',[id,req.user!.studentId!,accept]);
      await audit(req,{action:accept?'PLACEMENT_OFFER_ACCEPT':'PLACEMENT_OFFER_DECLINE',entity:'placement_offer',entityId:id},db);
    });
  } catch (err) {
    const message=friendlyDbError(err);
    if(message)throw new HttpError(400,message);
    throw err;
  }
  flash(req,'success',accept?'Offer accepted.':'Offer declined.');res.redirect('/student/placement/applications');
});

export const placementAdminRouter=Router();
const companySchema=z.object({company_name:z.string().trim().min(2).max(140),industry:z.string().trim().max(80),description:z.string().trim().max(3000),website_url:emptyToNull,contact_name:z.string().trim().max(100),contact_email:z.union([z.literal(''),z.email().max(120)]),contact_phone:z.string().trim().max(30),headquarters:z.string().trim().max(100)});
const nullableNumber = (min:number,max:number,integer=false) => z.preprocess(v=>v===''||v==null?null:Number(v),
  (integer?z.number().int():z.number()).min(min).max(max).nullable());
const driveBaseSchema=z.object({
  company_id:z.coerce.number().int().positive(),title:z.string().trim().min(3).max(160),role_title:z.string().trim().min(2).max(120),
  drive_type:z.enum(['FullTime','Internship']),description:z.string().trim().max(5000),job_location:z.string().trim().max(120),
  package_lpa:z.preprocess(v=>v===''?undefined:v,z.coerce.number().nonnegative().max(999999).optional()),
  stipend_monthly:z.preprocess(v=>v===''?undefined:v,z.coerce.number().nonnegative().max(99999999).optional()),
  min_year:z.coerce.number().int().min(1).max(6),min_cgpa:nullableNumber(0,10),max_active_backlogs:nullableNumber(0,100,true),
  min_attendance_pct:nullableNumber(0,100),opens_at:dateTimeInput,deadline:dateTimeInput,drive_date:z.union([z.literal(''),z.iso.date()]),
  status:z.enum(['Draft','Open']),program_ids:z.string().max(500),
});
const validDriveCompensation=(v:{drive_type:'FullTime'|'Internship';package_lpa?:number;stipend_monthly?:number})=>
  v.drive_type==='FullTime'?v.package_lpa!==undefined&&v.stipend_monthly===undefined:v.stipend_monthly!==undefined&&v.package_lpa===undefined;
const validDriveDeadline=(v:{opens_at:string;deadline:string})=>new Date(v.deadline).getTime()>new Date(v.opens_at).getTime();
const driveSchema=driveBaseSchema
  .refine(validDriveCompensation,{message:'Enter a package for full-time or monthly stipend for internship.'})
  .refine(validDriveDeadline,{path:['deadline'],message:'The application deadline must be later than the opening time.'});
const driveEditSchema=driveBaseSchema.omit({status:true})
  .refine(validDriveCompensation,{message:'Enter a package for full-time or monthly stipend for internship.'})
  .refine(validDriveDeadline,{path:['deadline'],message:'The application deadline must be later than the opening time.'});
const roundScheduleSchema=z.object({round_name:z.string().trim().min(2).max(100),description:z.string().trim().max(1000),scheduled_at:z.preprocess(v=>v===''||v==null?null:v,dateTimeInput.nullable())});
const roundTransitions:Record<string,string[]>={Planned:['InProgress','Cancelled'],InProgress:['Completed','Cancelled'],Completed:[],Cancelled:[]};
const driveTransitions:Record<string,string[]>={Draft:['Open','Cancelled'],Open:['Closed','Cancelled'],Closed:[],Cancelled:[]};
const localDateTime=(value:Date|string|null|undefined)=>{
  if(!value)return '';
  const date=new Date(value);
  return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date).replace(' ','T');
};
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
placementAdminRouter.get('/drives/new',async(_req,res)=>res.render('admin/placement-drive-form',{title:'Create drive',nav:'placement',companies:await query(`SELECT company_id,company_name FROM company WHERE is_active ORDER BY company_name`),programs:await query(`SELECT program_id,program_name FROM program WHERE is_active ORDER BY program_name`),errors:null,isEdit:false,action:'/admin/placement/drives',form:{}}));
placementAdminRouter.post('/drives',async(req,res)=>{
  const p=driveSchema.safeParse(req.body);if(!p.success){const [companies,programs]=await Promise.all([query(`SELECT company_id,company_name FROM company WHERE is_active ORDER BY company_name`),query(`SELECT program_id,program_name FROM program WHERE is_active ORDER BY program_name`)]);res.status(400).render('admin/placement-drive-form',{title:'Create drive',nav:'placement',companies,programs,errors:p.error.issues.map(i=>i.message),isEdit:false,action:'/admin/placement/drives',form:req.body});return;}
  const v=p.data,programIds=[...new Set(v.program_ids.split(',').map(x=>x.trim()).filter(Boolean))];
  if(programIds.some(x=>x.length>20))throw new HttpError(400,'Invalid program selection.');
  const id=await transaction(async db=>{
    const company=await db.query(`SELECT 1 FROM company WHERE company_id=$1 AND is_active FOR SHARE`,[v.company_id]);
    if(!company.rowCount)throw new HttpError(400,'Choose an active company.');
    if(programIds.length){
      const valid=await db.query(`SELECT program_id FROM program WHERE program_id=ANY($1::varchar[]) AND is_active FOR SHARE`,[programIds]);
      if(valid.rowCount!==programIds.length)throw new HttpError(400,'One or more selected programs are unavailable.');
    }
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
placementAdminRouter.get('/drives/:id/edit',async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)throw notFound('Placement drive');
  const drive=(await query(`SELECT d.*,c.company_name,(SELECT count(*) FROM placement_application a WHERE a.drive_id=d.drive_id)::int AS applicant_count FROM placement_drive d JOIN company c USING(company_id) WHERE d.drive_id=$1`,[id]))[0];
  if(!drive)throw notFound('Placement drive');
  if(drive.status!=='Draft'||drive.applicant_count>0)throw new HttpError(409,'Only Draft drives with no applications can be edited. Published or closed drives are locked.');
  const [companies,programs,selected]=await Promise.all([
    query(`SELECT company_id,company_name FROM company WHERE is_active OR company_id=$1 ORDER BY company_name`,[drive.company_id]),
    query(`SELECT program_id,program_name FROM program WHERE is_active OR program_id IN (SELECT program_id FROM drive_program WHERE drive_id=$1) ORDER BY program_name`,[id]),
    query(`SELECT program_id FROM drive_program WHERE drive_id=$1 ORDER BY program_id`,[id]),
  ]);
  const form={...drive,opens_at:localDateTime(drive.opens_at),deadline:localDateTime(drive.deadline),drive_date:drive.drive_date??'',program_ids:selected.map(p=>p.program_id).join(',')};
  res.render('admin/placement-drive-form',{title:'Edit placement drive',nav:'placement',companies,programs,errors:null,form,action:`/admin/placement/drives/${id}/edit`,isEdit:true});
});
placementAdminRouter.post('/drives/:id/edit',async(req,res)=>{
  const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)throw notFound('Placement drive');
  const p=driveEditSchema.safeParse(req.body);if(!p.success)throw new HttpError(400,p.error.issues.map(i=>i.message).join(' · '));
  const v=p.data,programIds=[...new Set(v.program_ids.split(',').map(x=>x.trim()).filter(Boolean))];
  if(programIds.some(x=>x.length>20))throw new HttpError(400,'Invalid program selection.');
  await transaction(async db=>{
    const current=await db.query(`SELECT status,company_id FROM placement_drive WHERE drive_id=$1 FOR UPDATE`,[id]);
    if(!current.rowCount)throw notFound('Placement drive');
    const count=await db.query(`SELECT count(*)::int AS count FROM placement_application WHERE drive_id=$1`,[id]);
    if(current.rows[0].status!=='Draft'||count.rows[0].count>0)throw new HttpError(409,'Only Draft drives with no applications can be edited. Published or closed drives are locked.');
    const company=await db.query(`SELECT 1 FROM company WHERE company_id=$1 AND (is_active OR company_id=$2)`,[v.company_id,current.rows[0].company_id]);
    if(!company.rowCount)throw new HttpError(400,'Choose an active company.');
    if(programIds.length){const valid=await db.query(`SELECT count(*)::int AS count FROM program p WHERE p.program_id=ANY($1::varchar[]) AND (p.is_active OR EXISTS (SELECT 1 FROM drive_program dp WHERE dp.drive_id=$2 AND dp.program_id=p.program_id))`,[programIds,id]);if(valid.rows[0].count!==programIds.length)throw new HttpError(400,'One or more selected programs are unavailable.');}
    await db.query(`UPDATE placement_drive SET company_id=$2,title=$3,role_title=$4,drive_type=$5,description=$6,job_location=$7,package_lpa=$8,stipend_monthly=$9,min_year=$10,min_cgpa=$11,max_active_backlogs=$12,min_attendance_pct=$13,opens_at=$14,deadline=$15,drive_date=$16 WHERE drive_id=$1`,
      [id,v.company_id,v.title,v.role_title,v.drive_type,v.description,v.job_location||null,v.package_lpa??null,v.stipend_monthly??null,v.min_year,v.min_cgpa,v.max_active_backlogs,v.min_attendance_pct,v.opens_at,v.deadline,v.drive_date||null]);
    await db.query(`DELETE FROM drive_program WHERE drive_id=$1`,[id]);
    for(const programId of programIds)await db.query(`INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)`,[id,programId]);
    if(current.rows[0].status==='Open')await db.query('CALL notify_eligible_placement_drive($1)',[id]);
    await audit(req,{action:'PLACEMENT_DRIVE_UPDATE',entity:'placement_drive',entityId:id,details:{programs:programIds.length}},db);
  });
  flash(req,'success','Placement drive updated.');res.redirect(`/admin/placement/drives/${id}`);
});
placementAdminRouter.get('/drives/:id',async(req,res)=>{
  const id=Number(req.params.id);const drive=(await query(`SELECT d.*,c.company_name FROM placement_drive d JOIN company c USING(company_id) WHERE drive_id=$1`,[id]))[0];if(!drive)throw notFound('Placement drive');
  const [applicants,rounds]=await Promise.all([getDriveApplicants(id),query(`SELECT * FROM drive_round WHERE drive_id=$1 ORDER BY sequence_no`,[id])]);
  res.render('admin/placement-drive-detail',{title:drive.title,nav:'placement',drive,applicants:applicants.map(a=>({...a,next_statuses:applicationTransitions[a.status]??[]})),rounds:rounds.map(r=>({...r,scheduled_local:localDateTime(r.scheduled_at)}))});
});
placementAdminRouter.post('/drives/:id/status',async(req,res)=>{
  const status=z.enum(['Draft','Open','Closed','Cancelled']).parse(req.body.status);const id=Number(req.params.id);
  await transaction(async db=>{const current=await db.query(`SELECT status FROM placement_drive WHERE drive_id=$1 FOR UPDATE`,[id]);if(!current.rowCount)throw notFound('Placement drive');if(!driveTransitions[current.rows[0].status]?.includes(status))throw new HttpError(409,`A drive cannot move from ${current.rows[0].status} to ${status}.`);await db.query(`UPDATE placement_drive SET status=$2 WHERE drive_id=$1`,[id,status]);if(status==='Open')await db.query('CALL notify_eligible_placement_drive($1)',[id]);await audit(req,{action:'PLACEMENT_DRIVE_STATUS',entity:'placement_drive',entityId:id,details:{from:current.rows[0].status,to:status}},db);});
  flash(req,'success',`Drive ${status.toLowerCase()}.`);res.redirect(`/admin/placement/drives/${id}`);
});
placementAdminRouter.post('/drives/:id/rounds',async(req,res)=>{
  const p=z.object({sequence_no:z.coerce.number().int().min(1).max(20),round_name:z.string().trim().min(2).max(100),description:z.string().trim().max(1000),scheduled_at:z.preprocess(v=>v===''||v==null?null:v,dateTimeInput.nullable())}).safeParse(req.body);if(!p.success)throw new HttpError(400,'Check the round details and schedule.');
  const id=Number(req.params.id);await transaction(async db=>{const r=await db.query(`INSERT INTO drive_round(drive_id,sequence_no,round_name,description,scheduled_at) VALUES($1,$2,$3,$4,$5) RETURNING round_id`,[id,p.data.sequence_no,p.data.round_name,p.data.description||null,p.data.scheduled_at||null]);await audit(req,{action:'PLACEMENT_ROUND_CREATE',entity:'drive_round',entityId:r.rows[0].round_id},db);});flash(req,'success','Round added.');res.redirect(`/admin/placement/drives/${id}`);
});
placementAdminRouter.post('/drives/:id/rounds/:roundId/edit',async(req,res)=>{
  const driveId=Number(req.params.id),roundId=Number(req.params.roundId);if(!Number.isInteger(driveId)||driveId<1||!Number.isInteger(roundId)||roundId<1)throw notFound('Recruitment round');
  const p=roundScheduleSchema.safeParse(req.body);if(!p.success)throw new HttpError(400,p.error.issues.map(i=>i.message).join(' · '));
  await transaction(async db=>{
    const current=await db.query(`SELECT status,scheduled_at FROM drive_round WHERE round_id=$1 AND drive_id=$2 FOR UPDATE`,[roundId,driveId]);
    if(!current.rowCount)throw notFound('Recruitment round');
    if(!['Planned','InProgress'].includes(current.rows[0].status))throw new HttpError(409,'Completed or cancelled rounds cannot be edited.');
    if(p.data.scheduled_at&&new Date(p.data.scheduled_at).getTime()<=Date.now()&&new Date(p.data.scheduled_at).getTime()!==new Date(current.rows[0].scheduled_at??0).getTime())throw new HttpError(400,'A new round schedule must be in the future.');
    await db.query(`UPDATE drive_round SET round_name=$1,description=$2,scheduled_at=$3 WHERE round_id=$4 AND drive_id=$5`,[p.data.round_name,p.data.description||null,p.data.scheduled_at,roundId,driveId]);
    await audit(req,{action:'PLACEMENT_ROUND_UPDATE',entity:'drive_round',entityId:roundId,details:{scheduled_at:p.data.scheduled_at}},db);
  });
  flash(req,'success','Round details updated.');res.redirect(`/admin/placement/drives/${driveId}`);
});
placementAdminRouter.post('/drives/:id/rounds/:roundId/status',async(req,res)=>{
  const driveId=Number(req.params.id),roundId=Number(req.params.roundId);if(!Number.isInteger(driveId)||driveId<1||!Number.isInteger(roundId)||roundId<1)throw notFound('Recruitment round');
  const parsed=z.enum(['InProgress','Completed','Cancelled']).safeParse(req.body.status);if(!parsed.success)throw new HttpError(400,'Choose a valid round status.');
  const status=parsed.data;
  await transaction(async db=>{
    const current=await db.query(`SELECT status,scheduled_at FROM drive_round WHERE round_id=$1 AND drive_id=$2 FOR UPDATE`,[roundId,driveId]);
    if(!current.rowCount)throw notFound('Recruitment round');
    const from=current.rows[0].status as string;
    if(!roundTransitions[from]?.includes(status))throw new HttpError(409,`A round cannot move from ${from} to ${status}.`);
    if(status==='InProgress'&&current.rows[0].scheduled_at&&new Date(current.rows[0].scheduled_at).getTime()>Date.now())throw new HttpError(409,'A round cannot start before its scheduled time.');
    await db.query(`UPDATE drive_round SET status=$1 WHERE round_id=$2 AND drive_id=$3`,[status,roundId,driveId]);
    await audit(req,{action:'PLACEMENT_ROUND_STATUS',entity:'drive_round',entityId:roundId,details:{from,to:status}},db);
  });
  flash(req,'success',`Round marked ${status.toLowerCase()}.`);res.redirect(`/admin/placement/drives/${driveId}`);
});
placementAdminRouter.post('/applications/:id/status',async(req,res)=>{
  const status=z.enum(['Shortlisted','Selected','Rejected']).parse(req.body.status);const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)throw notFound('Application');
  const row=await transaction(async db=>{
    const current=await db.query(`SELECT drive_id,status FROM placement_application WHERE application_id=$1 FOR UPDATE`,[id]);
    if(!current.rowCount)throw notFound('Application');
    const from=current.rows[0].status as string;
    if(!applicationTransitions[from]?.includes(status))throw new HttpError(409,`An application cannot move from ${from} to ${status}.`);
    await db.query(`UPDATE placement_application SET status=$2,updated_at=now() WHERE application_id=$1`,[id,status]);
    await audit(req,{action:'PLACEMENT_APPLICATION_STATUS',entity:'placement_application',entityId:id,details:{from,to:status}},db);
    return {drive_id:current.rows[0].drive_id};
  });
  flash(req,'success',`Application marked ${status.toLowerCase()}.`);res.redirect(`/admin/placement/drives/${row.drive_id}`);
});
placementAdminRouter.post('/applications/:id/results',async(req,res)=>{
  const p=z.object({round_id:z.coerce.number().int().positive(),result:z.enum(['Pending','Passed','Failed','OnHold']),private_remarks:z.string().trim().max(1000)}).parse(req.body);const id=Number(req.params.id);
  const driveId=await transaction(async db=>{const app=await db.query(`SELECT drive_id FROM placement_application WHERE application_id=$1`,[id]);if(!app.rowCount)throw notFound('Application');await db.query(`INSERT INTO round_result(drive_id,application_id,round_id,result,private_remarks) VALUES($1,$2,$3,$4,$5) ON CONFLICT(application_id,round_id) DO UPDATE SET result=EXCLUDED.result,private_remarks=EXCLUDED.private_remarks,result_at=now()`,[app.rows[0].drive_id,id,p.round_id,p.result,p.private_remarks||null]);await audit(req,{action:'PLACEMENT_ROUND_RESULT',entity:'placement_application',entityId:id,details:{round_id:p.round_id,result:p.result}},db);return app.rows[0].drive_id;});flash(req,'success','Round result saved.');res.redirect(`/admin/placement/drives/${driveId}`);
});
placementAdminRouter.post('/applications/:id/offers',async(req,res)=>{
  const parsed=z.object({package_lpa:nullableNumber(0,999999),stipend_monthly:nullableNumber(0,99999999),response_deadline:dateTimeInput,joining_date:z.union([z.literal(''),z.iso.date()])}).refine(v=>(v.package_lpa===null)!==(v.stipend_monthly===null)).refine(v=>new Date(v.response_deadline).getTime()>Date.now(),{path:['response_deadline'],message:'The offer response deadline must be in the future.'}).safeParse(req.body);
  if(!parsed.success)throw new HttpError(400,parsed.error.issues.map(issue=>issue.message).join(' · '));
  const p=parsed.data,id=Number(req.params.id);
  const driveId=await transaction(async db=>{const app=await db.query(`SELECT drive_id FROM placement_application WHERE application_id=$1`,[id]);if(!app.rowCount)throw notFound('Application');const r=await db.query(`INSERT INTO placement_offer(application_id,package_lpa,stipend_monthly,response_deadline,joining_date) VALUES($1,$2,$3,$4,$5) RETURNING offer_id`,[id,p.package_lpa,p.stipend_monthly,p.response_deadline,p.joining_date||null]);await audit(req,{action:'PLACEMENT_OFFER_CREATE',entity:'placement_offer',entityId:r.rows[0].offer_id},db);return app.rows[0].drive_id;});flash(req,'success','Offer recorded.');res.redirect(`/admin/placement/drives/${driveId}`);
});
placementAdminRouter.get('/drives/:id/applicants.csv',async(req,res)=>{
  const driveId=Number(req.params.id);const rows=await query(`SELECT s.student_number,s.first_name,s.last_name,p.program_name,a.status,a.applied_at FROM placement_application a JOIN student s USING(student_id) JOIN program p USING(program_id) WHERE a.drive_id=$1 ORDER BY a.applied_at`,[driveId]);
  res.type('text/csv').attachment(`placement-applicants-${driveId}.csv`).send(['Student number,First name,Last name,Program,Status,Applied at',...rows.map(r=>[r.student_number,r.first_name,r.last_name,r.program_name,r.status,r.applied_at].map(escapeCsvCell).join(','))].join('\r\n'));
});
placementAdminRouter.get('/statistics',async(req,res)=>{
  const departments=await query<{dept_id:string;dept_name:string}>('SELECT dept_id,dept_name FROM department ORDER BY dept_name');
  const requestedDeptId=req.query.dept_id;
  let selectedDepartment:typeof departments[number]|undefined;
  if(requestedDeptId!==undefined&&requestedDeptId!==''){
    if(typeof requestedDeptId!=='string'||requestedDeptId.length>10)
      throw new HttpError(400,'Choose a valid branch.');
    selectedDepartment=departments.find(d=>d.dept_id===requestedDeptId);
    if(!selectedDepartment)throw new HttpError(400,'Choose a valid branch.');
  }
  const years=await getAdminExpectedGraduationYears(selectedDepartment?.dept_id);
  const requestedYear=req.query.expected_graduation_year;
  let selectedYear:number|undefined;
  if(requestedYear!==undefined&&requestedYear!==''){
    if(typeof requestedYear!=='string'||!/^\d{4}$/.test(requestedYear))
      throw new HttpError(400,'Choose a valid expected passing-out year.');
    selectedYear=Number(requestedYear);
    if(!years.some(row=>row.expected_graduation_year===selectedYear))
      throw new HttpError(400,'Choose a valid expected passing-out year.');
  }
  const [overview,companyOffers,packageDistribution,byDepartment,batchStats]=await Promise.all([
    getAdminPlacementOverview(undefined,selectedDepartment?.dept_id,selectedYear),
    getCompanyPlacementOffers(selectedDepartment?.dept_id,undefined,selectedYear),
    getAcceptedFullTimePackageDistribution(undefined,selectedDepartment?.dept_id,selectedYear),
    getAdminDepartmentPlacementStats(selectedDepartment?.dept_id,undefined,selectedYear),
    getAdminBatchPlacementStats(undefined,selectedDepartment?.dept_id,selectedYear),
  ]);
  const maxPackages=Math.max(0,...packageDistribution.map((b)=>b.offer_count));
  const reportingScope=[
    selectedDepartment?.dept_name??'All branches (institution-wide)',
    selectedYear===undefined?'All batches':'Batch '+selectedYear+' (recorded expected graduation year)',
  ].join(' · ');
  res.render('admin/placement-statistics',{title:'Placement statistics',nav:'placement',
    overview:{...overview,overall_placement_pct:placementPercentage(overview?.placed_students??0,overview?.active_students??0)},
    byDepartment:byDepartment.map((d)=>({...d,bar_pct:chartBarPercent(d.placed_pct??0,100)})),
    departments,selectedDepartment:selectedDepartment?.dept_id??'',years,selectedYear:selectedYear??'',
    batchStats,unassignedStudents:byDepartment.reduce((total,row)=>total+row.unverified_cohort_students,0),
    reportingScope,
    companyOffers,packageDistribution:packageDistribution.map((b)=>({...b,bar_pct:chartBarPercent(b.offer_count,maxPackages)})),
    hasPackageData:maxPackages>0});
});

export const placementFacultyRouter=Router();
placementFacultyRouter.get('/placement',async(req,res)=>{
  if(!req.user!.isHod)throw forbidden();
  res.render('faculty/placement-report',{title:'Department placement report',nav:'placement',rows:await getDepartmentPlacementReport(req.user!.deptId!)});
});
