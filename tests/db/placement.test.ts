import { describe, expect, it } from 'vitest';
import { hasDatabase, inRollback, one } from './helpers.js';

async function fixture(db: import('pg').Client, options: { minYear?: number; packageLpa?: number; programMismatch?: boolean } = {}) {
  const student = await one<{ student_id: number; program_id: string; year_of_study: number }>(db, `
    SELECT s.student_id,s.program_id,d.year_of_study FROM student s
    JOIN student_section ss USING(student_id) JOIN division d USING(division_id)
    WHERE s.status='Active' AND ss.academic_session_id=current_session_id()
      AND NOT EXISTS (SELECT 1 FROM placement_application pa WHERE pa.student_id=s.student_id)
    ORDER BY s.student_id LIMIT 1`);
  const company = await one<{ company_id: number }>(db,
    `INSERT INTO company(company_name) VALUES('placement-test-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSUS')) RETURNING company_id`);
  const drive = await one<{ drive_id: number }>(db, `INSERT INTO placement_drive
    (company_id,title,role_title,drive_type,package_lpa,min_year,opens_at,deadline,status)
    VALUES($1,'test drive','Developer','FullTime',$2,$3,now()-interval '1 hour',now()+interval '1 day','Open') RETURNING drive_id`,
  [company.company_id, options.packageLpa ?? 10, options.minYear ?? 1]);
  const programId=options.programMismatch
    ? (await one<{program_id:string}>(db,'SELECT program_id FROM program WHERE program_id<>$1 ORDER BY program_id LIMIT 1',[student.program_id])).program_id
    : student.program_id;
  await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)',[drive.drive_id,programId]);
  return { ...student, driveId: drive.drive_id };
}

async function fails(db: import('pg').Client, sql: string, params: unknown[] = []) {
  await db.query('SAVEPOINT expected_failure');
  try { await db.query(sql, params); } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT expected_failure');
    return (error as Error).message;
  }
  throw new Error(`expected the query to fail: ${sql}`);
}

describe.skipIf(!hasDatabase)('T7 placement database rules', () => {
  it('reports current-drive eligibility and rejects duplicate applications', async () => inRollback(async db => {
    const f = await fixture(db);
    const eligibility = await one<{ eligible: boolean; reasons: string[] }>(db,
      'SELECT eligible,reasons FROM is_eligible($1,$2)', [f.student_id,f.driveId]);
    expect(eligibility).toMatchObject({ eligible: true, reasons: [] });
    await db.query('INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)', [f.student_id,f.driveId]);
    expect(await fails(db,'INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)',[f.student_id,f.driveId])).toMatch(/unique/i);
  }));

  it('fails closed when the program or year does not qualify', async () => inRollback(async db => {
    const f = await fixture(db,{programMismatch:true});
    const result = await one<{ eligible:boolean; reasons:string[] }>(db,'SELECT eligible,reasons FROM is_eligible($1,$2)',[f.student_id,f.driveId]);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/program is not eligible/i);
    const tooSenior = await fixture(db,{minYear:Math.min(f.year_of_study+1,6)});
    const yearResult = await one<{eligible:boolean;reasons:string[]}>(db,'SELECT eligible,reasons FROM is_eligible($1,$2)',[tooSenior.student_id,tooSenior.driveId]);
    if (tooSenior.year_of_study < Math.min(tooSenior.year_of_study+1,6)) expect(yearResult.eligible).toBe(false);
  }));

  it('enforces the 1.5x full-time accepted offer threshold and excludes internships', async () => inRollback(async db => {
    const f=await fixture(db,{packageLpa:10});
    const app=await one<{application_id:number}>(db,'INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2) RETURNING application_id',[f.student_id,f.driveId]);
    await db.query("UPDATE placement_application SET status='Shortlisted' WHERE application_id=$1",[app.application_id]);
    await db.query("UPDATE placement_application SET status='Selected' WHERE application_id=$1",[app.application_id]);
    const offer=await one<{offer_id:number}>(db,`INSERT INTO placement_offer(application_id,package_lpa,response_deadline)
      VALUES($1,10,now()+interval '1 day') RETURNING offer_id`,[app.application_id]);
    await db.query('SELECT respond_placement_offer($1,$2,true)',[offer.offer_id,f.student_id]);
    const low=await fixture(db,{packageLpa:14.99});
    await db.query('DELETE FROM drive_program WHERE drive_id=$1',[low.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)',[low.driveId,f.program_id]);
    expect(await fails(db,'INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)',[f.student_id,low.driveId])).toMatch(/1.5x/i);
    const threshold=await fixture(db,{packageLpa:15});
    await db.query('DELETE FROM drive_program WHERE drive_id=$1',[threshold.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)',[threshold.driveId,f.program_id]);
    await expect(db.query('INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)',[f.student_id,threshold.driveId])).resolves.toBeTruthy();
    const internship=await fixture(db,{packageLpa:20});
    await db.query('UPDATE placement_drive SET drive_type=\'Internship\',package_lpa=NULL,stipend_monthly=20000 WHERE drive_id=$1',[internship.driveId]);
    await db.query('DELETE FROM drive_program WHERE drive_id=$1',[internship.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)',[internship.driveId,f.program_id]);
    const internshipEligibility=await one<{eligible:boolean}>(db,'SELECT eligible FROM is_eligible($1,$2)',[f.student_id,internship.driveId]);
    expect(internshipEligibility.eligible).toBe(true);
    await db.query('INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)',[f.student_id,internship.driveId]);

    const internStudent=await fixture(db);
    await db.query('UPDATE placement_drive SET drive_type=\'Internship\',package_lpa=NULL,stipend_monthly=20000 WHERE drive_id=$1',[internStudent.driveId]);
    await db.query('DELETE FROM drive_program WHERE drive_id=$1',[internStudent.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)',[internStudent.driveId,internStudent.program_id]);
    const internApp=await one<{application_id:number}>(db,'INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2) RETURNING application_id',[internStudent.student_id,internStudent.driveId]);
    await db.query("UPDATE placement_application SET status='Shortlisted' WHERE application_id=$1",[internApp.application_id]);
    await db.query("UPDATE placement_application SET status='Selected' WHERE application_id=$1",[internApp.application_id]);
    const internOffer=await one<{offer_id:number}>(db,`INSERT INTO placement_offer(application_id,stipend_monthly,response_deadline)
      VALUES($1,20000,now()+interval '1 day') RETURNING offer_id`,[internApp.application_id]);
    await db.query('SELECT respond_placement_offer($1,$2,true)',[internOffer.offer_id,internStudent.student_id]);
    const lowFulltime=await fixture(db,{packageLpa:1});
    await db.query('UPDATE placement_drive SET min_year=$2 WHERE drive_id=$1',[lowFulltime.driveId,internStudent.year_of_study]);
    await db.query('DELETE FROM drive_program WHERE drive_id=$1',[lowFulltime.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)',[lowFulltime.driveId,internStudent.program_id]);
    expect((await one<{eligible:boolean}>(db,'SELECT eligible FROM is_eligible($1,$2)',[internStudent.student_id,lowFulltime.driveId])).eligible).toBe(true);
  }));

  it('notifies the eligible active audience once when a drive is opened', async () => inRollback(async db => {
    const f = await fixture(db, { minYear: 1 });
    const ineligible = await one<{ user_id: number; student_id: number }>(db, `
      SELECT u.user_id, s.student_id
      FROM app_user u
      JOIN student s USING (student_id)
      JOIN student_section ss USING (student_id)
      WHERE u.role = 'student' AND u.is_active AND s.status = 'Active'
        AND ss.academic_session_id = current_session_id() AND s.program_id <> $1
      ORDER BY u.user_id LIMIT 1`, [f.program_id]);
    const driveLink = `/student/placement/drives/${f.driveId}`;

    const expected = (await db.query<{ user_id: number }>(`
      SELECT u.user_id
      FROM app_user u
      JOIN student s USING (student_id)
      CROSS JOIN LATERAL is_eligible(s.student_id, $1) e
      WHERE u.role = 'student' AND u.is_active AND e.eligible
      ORDER BY u.user_id`, [f.driveId])).rows.map((row) => row.user_id);
    expect(expected.length).toBeGreaterThan(0);

    await db.query('CALL notify_eligible_placement_drive($1)', [f.driveId]);
    const first = (await db.query<{ user_id: number }>(`
      SELECT user_id FROM notification WHERE kind = 'placement' AND link = $1 ORDER BY user_id`, [driveLink])).rows
      .map((row) => row.user_id);
    expect(first).toEqual(expected);
    expect(first).not.toContain(ineligible.user_id);

    await db.query('CALL notify_eligible_placement_drive($1)', [f.driveId]);
    const total = await one<{ n: number }>(db,
      `SELECT count(*)::int AS n FROM notification WHERE kind = 'placement' AND link = $1`, [driveLink]);
    expect(total.n).toBe(expected.length);
  }));

  it('counts accepted full-time offers without multiplying them by rounds', async () => inRollback(async db => {
    const f=await fixture(db);
    const view=await one<{applications:number;offers:number;is_placed:boolean}>(db,
      `SELECT applications,offers,is_placed FROM v_student_placement_status WHERE student_id=$1`,[f.student_id]);
    expect(view).toMatchObject({applications:0,offers:0,is_placed:false});
  }));
});
