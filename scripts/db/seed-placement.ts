/** Idempotently adds fictional local placement data. Never run on Supabase. */
import { withClient } from './client.js';

const url = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !['5432', '54329', ''].includes(url.port) || url.pathname !== '/erp') {
  throw new Error('Placement demo seed is restricted to localhost/erp.');
}

const companies = Array.from({ length: 40 }, (_, i) => ({
  name: `Synthetic TnP Company ${String(i + 1).padStart(2, '0')}`,
  industry: ['Software', 'Analytics', 'Finance', 'Manufacturing', 'Consulting'][i % 5],
}));

async function main() {
  await withClient(async db => {
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL search_path = erp, public');
      const companyIds: number[] = [];
      for (const company of companies) {
        await db.query(`INSERT INTO company(company_name,industry,description,headquarters)
          VALUES($1,$2,'Synthetic development data','Pune') ON CONFLICT(lower(company_name)) DO NOTHING`, [company.name, company.industry]);
        const row = await db.query<{ company_id: number }>('SELECT company_id FROM company WHERE lower(company_name)=lower($1)', [company.name]);
        companyIds.push(row.rows[0]!.company_id);
      }
      const candidates = await db.query<{student_id:number;program_id:string;year_of_study:number}>(`SELECT s.student_id,s.program_id,d.year_of_study
        FROM student s JOIN student_section ss USING(student_id) JOIN division d USING(division_id)
        WHERE s.status='Active' AND ss.academic_session_id=current_session_id() ORDER BY s.student_id`);
      const byYear = new Map<number, typeof candidates.rows>();
      for (const candidate of candidates.rows) byYear.set(candidate.year_of_study,[...(byYear.get(candidate.year_of_study)??[]),candidate]);
      const offsets = new Map<number,number>();
      const now = new Date();
      for (let i = 0; i < 60; i++) {
        const type = i % 3 === 0 ? 'Internship' : 'FullTime';
        const opens = new Date(now.getTime() - 86_400_000).toISOString();
        const deadline = new Date(now.getTime() + (15 + (i % 15)) * 86_400_000).toISOString();
        const row = await db.query<{ drive_id: number }>(`INSERT INTO placement_drive
          (company_id,title,role_title,drive_type,description,job_location,package_lpa,stipend_monthly,min_year,opens_at,deadline,status)
          VALUES($1,$2,$3,$4,'Synthetic placement demonstration drive','Pune',$5,$6,$7,$8,$9,'Open')
          ON CONFLICT(company_id,title) DO NOTHING RETURNING drive_id`,
        [companyIds[i % companyIds.length], `2026-27 Opportunity ${String(i + 1).padStart(2, '0')}`,
          ['Graduate Engineer', 'Software Intern', 'Data Analyst', 'Associate Consultant'][i % 4], type,
          type === 'FullTime' ? 5 + (i % 18) : null, type === 'Internship' ? 15000 + (i % 8) * 5000 : null,
          type === 'FullTime' ? 4 : 3, opens, deadline]);
        const existingDrive=row.rows[0] ?? (await db.query<{drive_id:number}>('SELECT drive_id FROM placement_drive WHERE company_id=$1 AND title=$2',[companyIds[i % companyIds.length],`2026-27 Opportunity ${String(i + 1).padStart(2, '0')}`])).rows[0];
        const driveId=existingDrive!.drive_id;
        const rounds=[];
        for(const [sequence_no,round_name] of [[1,'Online assessment'],[2,'Technical interview'],[3,'HR interview']] as const){
          const round=await db.query<{round_id:number}>(`INSERT INTO drive_round(drive_id,sequence_no,round_name)
            VALUES($1,$2,$3) ON CONFLICT(drive_id,sequence_no) DO NOTHING RETURNING round_id`,[driveId,sequence_no,round_name]);
          const existingRound=round.rows[0] ?? (await db.query<{round_id:number}>('SELECT round_id FROM drive_round WHERE drive_id=$1 AND sequence_no=$2',[driveId,sequence_no])).rows[0];
          rounds.push(existingRound!.round_id);
        }
        if(i%4===3) continue;
        const year=type==='FullTime'?4:3;
        const pool=byYear.get(year)??[];const offset=offsets.get(year)??0;const candidate=pool[offset];
        if(!candidate) continue;
        offsets.set(year,offset+1);
        if(i%2===0) await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[driveId,candidate.program_id]);
        const application=await db.query<{application_id:number;status:string}>(`INSERT INTO placement_application(student_id,drive_id)
          VALUES($1,$2) ON CONFLICT(student_id,drive_id) DO NOTHING RETURNING application_id,status`,[candidate.student_id,driveId]);
        let applicationId=application.rows[0]?.application_id;
        let appStatus=application.rows[0]?.status;
        if(!applicationId){const existing=await db.query<{application_id:number;status:string}>('SELECT application_id,status FROM placement_application WHERE student_id=$1 AND drive_id=$2',[candidate.student_id,driveId]);applicationId=existing.rows[0]!.application_id;appStatus=existing.rows[0]!.status;}
        if(application.rows.length){
          if(i%4>=1) await db.query("UPDATE placement_application SET status='Shortlisted' WHERE application_id=$1",[applicationId]);
          if(i%4===2) await db.query("UPDATE placement_application SET status='Selected' WHERE application_id=$1",[applicationId]);
        }
        if(appStatus==='Selected'||i%4===2){
          for(let j=0;j<rounds.length;j++) await db.query(`INSERT INTO round_result(drive_id,application_id,round_id,result,private_remarks)
            VALUES($1,$2,$3,$4,'Synthetic demo result') ON CONFLICT(application_id,round_id) DO NOTHING`,[driveId,applicationId,rounds[j],j<2?'Passed':'Pending']);
          const offer=await db.query<{offer_id:number;status:string}>(`INSERT INTO placement_offer(application_id,package_lpa,stipend_monthly,response_deadline)
            VALUES($1,$2,$3,now()+interval '7 days') ON CONFLICT(application_id) DO NOTHING RETURNING offer_id,status`,
          [applicationId,type==='FullTime'?5+(i%18):null,type==='Internship'?15000+(i%8)*5000:null]);
          if(offer.rows[0]&&i%8===2) await db.query('SELECT respond_placement_offer($1,$2,true)',[offer.rows[0].offer_id,candidate.student_id]);
        }
      }
      await db.query('COMMIT');
      console.log('Placement seed complete: 40 companies, 60 drives, and eligible synthetic applications, rounds, and offers.');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  });
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Placement seed failed'); process.exit(1); });
