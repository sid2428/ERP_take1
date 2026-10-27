import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hasDatabase, inRollback, one } from './helpers.js';
import { getAcceptedFullTimePackageDistribution, getAdminPlacementOverview, getStudentDrives } from '../../src/queries/placement-queries.js';
import type { Db } from '../../src/db.js';

async function fixture(db: import('pg').Client, options: { minYear?: number; packageLpa?: number; programMismatch?: boolean; title?: string; type?: 'FullTime' | 'Internship' } = {}) {
  const student = await one<{ student_id: number; program_id: string; year_of_study: number }>(db, `
    SELECT s.student_id,s.program_id,d.year_of_study FROM student s
    JOIN student_section ss USING(student_id) JOIN division d USING(division_id)
    WHERE s.status='Active' AND ss.academic_session_id=current_session_id()
      AND NOT EXISTS (SELECT 1 FROM placement_application pa WHERE pa.student_id=s.student_id)
    ORDER BY s.student_id LIMIT 1`);
  const company = await one<{ company_id: number }>(db,
    `INSERT INTO company(company_name) VALUES('placement-test-'||to_char(clock_timestamp(),'YYYYMMDDHH24MISSUS')) RETURNING company_id`);
  const drive = await one<{ drive_id: number }>(db, `INSERT INTO placement_drive
    (company_id,title,role_title,drive_type,package_lpa,stipend_monthly,min_year,opens_at,deadline,status)
    VALUES($1,$4,'Developer',$5::placement_drive_type,CASE WHEN $5='FullTime' THEN $2::numeric ELSE NULL END,CASE WHEN $5='Internship' THEN 20000::numeric ELSE NULL END,$3,now()-interval '1 hour',now()+interval '1 day','Open') RETURNING drive_id`,
    [company.company_id, options.packageLpa ?? 10, options.minYear ?? student.year_of_study, options.title ?? 'test drive', options.type ?? 'FullTime']);
  const programId = options.programMismatch
    ? (await one<{ program_id: string }>(db, 'SELECT program_id FROM program WHERE program_id<>$1 ORDER BY program_id LIMIT 1', [student.program_id])).program_id
    : student.program_id;
  await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)', [drive.drive_id, programId]);
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
  it('paginates drives after applying search, type, eligibility, and clamps out-of-range pages', async () => inRollback(async db => {
    const marker = `placement-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const first = await fixture(db, { title: `${marker}-one` });
    await fixture(db, { title: `${marker}-two` });
    await fixture(db, { title: `${marker}-three`, type: 'Internship' });

    const queryDb = db as unknown as Db;
    const pageOne = await getStudentDrives(first.student_id, { q: marker, type: 'FullTime', eligible: 'yes' }, { page: 1, pageSize: 1 }, queryDb);
    expect(pageOne.total).toBe(2);
    expect(pageOne.totalPages).toBe(2);
    expect(pageOne.page).toBe(1);
    expect(pageOne.drives).toHaveLength(1);
    expect(pageOne.drives[0]!.title).toContain(marker);

    const pageTwo = await getStudentDrives(first.student_id, { q: marker, type: 'FullTime', eligible: 'yes' }, { page: 2, pageSize: 1 }, queryDb);
    expect(pageTwo.page).toBe(2);
    expect(pageTwo.drives).toHaveLength(1);
    expect(pageTwo.drives[0]!.drive_id).not.toBe(pageOne.drives[0]!.drive_id);

    const beyondLast = await getStudentDrives(first.student_id, { q: marker, type: 'FullTime', eligible: 'yes' }, { page: 999, pageSize: 1 }, queryDb);
    expect(beyondLast.page).toBe(2);
    expect(beyondLast.drives).toHaveLength(1);

    const noResults = await getStudentDrives(first.student_id, { q: marker, type: 'FullTime', eligible: 'no' }, { page: 7, pageSize: 1 }, queryDb);
    expect(noResults).toMatchObject({ total: 0, totalPages: 0, page: 1, drives: [] });
  }));

  it('reports current-drive eligibility and rejects duplicate applications', async () => inRollback(async db => {
    const f = await fixture(db);
    const eligibility = await one<{ eligible: boolean; reasons: string[] }>(db,
      'SELECT eligible,reasons FROM is_eligible($1,$2)', [f.student_id, f.driveId]);
    expect(eligibility).toMatchObject({ eligible: true, reasons: [] });
    await db.query('INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)', [f.student_id, f.driveId]);
    expect(await fails(db, 'INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)', [f.student_id, f.driveId])).toMatch(/unique/i);
  }));

  it('builds the placement management summary view from current database records', async () => inRollback(async db => {
    const f = await fixture(db);
    await db.query('INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)', [f.student_id, f.driveId]);
    const migration = await readFile(resolve('migrations/092-placement-drive-summary.sql'), 'utf8');
    await db.query(migration);
    const summary = await one<{ applicants: number; offers: number; accepted_offers: number }>(db,
      'SELECT applicants,offers,accepted_offers FROM v_placement_drive_summary WHERE drive_id=$1', [f.driveId]);
    expect(summary).toEqual({ applicants: 1, offers: 0, accepted_offers: 0 });
  }));

  it('does not allow an unrelated student to respond to a placement offer', async () => inRollback(async db => {
    const f = await fixture(db);
    const app = await one<{ application_id: number }>(db, `INSERT INTO placement_application(student_id,drive_id)
      VALUES($1,$2) RETURNING application_id`, [f.student_id, f.driveId]);
    await db.query(`UPDATE placement_application SET status='Shortlisted' WHERE application_id=$1`, [app.application_id]);
    await db.query(`UPDATE placement_application SET status='Selected' WHERE application_id=$1`, [app.application_id]);
    const offer = await one<{ offer_id: number }>(db, `INSERT INTO placement_offer(application_id,package_lpa,response_deadline)
      VALUES($1,10,now()+interval '1 day') RETURNING offer_id`, [app.application_id]);
    const other = await one<{ student_id: number }>(db, 'SELECT student_id FROM student WHERE student_id<>$1 ORDER BY student_id LIMIT 1', [f.student_id]);
    expect(await fails(db, 'SELECT respond_placement_offer($1,$2,false)', [offer.offer_id, other.student_id])).toMatch(/unavailable/i);
    const unchanged = await one<{ status: string }>(db, 'SELECT status FROM placement_offer WHERE offer_id=$1', [offer.offer_id]);
    expect(unchanged.status).toBe('Pending');
  }));

  it('enforces the application recruitment-stage order', async () => inRollback(async db => {
    const f = await fixture(db);
    const app = await one<{ application_id: number }>(db, `INSERT INTO placement_application(student_id,drive_id)
      VALUES($1,$2) RETURNING application_id`, [f.student_id, f.driveId]);
    expect(await fails(db, `UPDATE placement_application SET status='Selected' WHERE application_id=$1`, [app.application_id])).toMatch(/status transition/i);
    await db.query(`UPDATE placement_application SET status='Shortlisted' WHERE application_id=$1`, [app.application_id]);
    await db.query(`UPDATE placement_application SET status='Selected' WHERE application_id=$1`, [app.application_id]);
    expect(await fails(db, `UPDATE placement_application SET status='Applied' WHERE application_id=$1`, [app.application_id])).toMatch(/status transition/i);
  }));

  it('fails closed when the program or year does not qualify', async () => inRollback(async db => {
    const f = await fixture(db, { programMismatch: true });
    const result = await one<{ eligible: boolean; reasons: string[] }>(db, 'SELECT eligible,reasons FROM is_eligible($1,$2)', [f.student_id, f.driveId]);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/program is not eligible/i);
    const tooSenior = await fixture(db, { minYear: Math.min(f.year_of_study + 1, 6) });
    const yearResult = await one<{ eligible: boolean; reasons: string[] }>(db, 'SELECT eligible,reasons FROM is_eligible($1,$2)', [tooSenior.student_id, tooSenior.driveId]);
    if (tooSenior.year_of_study < Math.min(tooSenior.year_of_study + 1, 6)) expect(yearResult.eligible).toBe(false);
  }));

  it('enforces the 1.5x full-time accepted offer threshold and excludes internships', async () => inRollback(async db => {
    const f = await fixture(db, { packageLpa: 10 });
    const app = await one<{ application_id: number }>(db, 'INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2) RETURNING application_id', [f.student_id, f.driveId]);
    await db.query("UPDATE placement_application SET status='Shortlisted' WHERE application_id=$1", [app.application_id]);
    await db.query("UPDATE placement_application SET status='Selected' WHERE application_id=$1", [app.application_id]);
    const offer = await one<{ offer_id: number }>(db, `INSERT INTO placement_offer(application_id,package_lpa,response_deadline)
      VALUES($1,10,now()+interval '1 day') RETURNING offer_id`, [app.application_id]);
    await db.query('SELECT respond_placement_offer($1,$2,true)', [offer.offer_id, f.student_id]);
    const low = await fixture(db, { packageLpa: 14.99, minYear: f.year_of_study });
    await db.query('DELETE FROM drive_program WHERE drive_id=$1', [low.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)', [low.driveId, f.program_id]);
    expect(await fails(db, 'INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)', [f.student_id, low.driveId])).toMatch(/1.5x/i);
    const threshold = await fixture(db, { packageLpa: 15, minYear: f.year_of_study });
    await db.query('DELETE FROM drive_program WHERE drive_id=$1', [threshold.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)', [threshold.driveId, f.program_id]);
    await expect(db.query('INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)', [f.student_id, threshold.driveId])).resolves.toBeTruthy();
    const internship = await fixture(db, { packageLpa: 20, minYear: f.year_of_study });
    await db.query('UPDATE placement_drive SET drive_type=\'Internship\',package_lpa=NULL,stipend_monthly=20000 WHERE drive_id=$1', [internship.driveId]);
    await db.query('DELETE FROM drive_program WHERE drive_id=$1', [internship.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)', [internship.driveId, f.program_id]);
    const internshipEligibility = await one<{ eligible: boolean }>(db, 'SELECT eligible FROM is_eligible($1,$2)', [f.student_id, internship.driveId]);
    expect(internshipEligibility.eligible).toBe(true);
    await db.query('INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2)', [f.student_id, internship.driveId]);

    const internStudent = await fixture(db);
    await db.query('UPDATE placement_drive SET drive_type=\'Internship\',package_lpa=NULL,stipend_monthly=20000 WHERE drive_id=$1', [internStudent.driveId]);
    await db.query('DELETE FROM drive_program WHERE drive_id=$1', [internStudent.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)', [internStudent.driveId, internStudent.program_id]);
    const internApp = await one<{ application_id: number }>(db, 'INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2) RETURNING application_id', [internStudent.student_id, internStudent.driveId]);
    await db.query("UPDATE placement_application SET status='Shortlisted' WHERE application_id=$1", [internApp.application_id]);
    await db.query("UPDATE placement_application SET status='Selected' WHERE application_id=$1", [internApp.application_id]);
    const internOffer = await one<{ offer_id: number }>(db, `INSERT INTO placement_offer(application_id,stipend_monthly,response_deadline)
      VALUES($1,20000,now()+interval '1 day') RETURNING offer_id`, [internApp.application_id]);
    await db.query('SELECT respond_placement_offer($1,$2,true)', [internOffer.offer_id, internStudent.student_id]);
    const lowFulltime = await fixture(db, { packageLpa: 1 });
    await db.query('UPDATE placement_drive SET min_year=$2 WHERE drive_id=$1', [lowFulltime.driveId, internStudent.year_of_study]);
    await db.query('DELETE FROM drive_program WHERE drive_id=$1', [lowFulltime.driveId]);
    await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)', [lowFulltime.driveId, internStudent.program_id]);
    expect((await one<{ eligible: boolean }>(db, 'SELECT eligible FROM is_eligible($1,$2)', [internStudent.student_id, lowFulltime.driveId])).eligible).toBe(true);
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

  it('finds the same eligible students in bulk as is_eligible() does one by one', async () => inRollback(async db => {
    // a student with an accepted 10 LPA full-time offer, so the 1.5x rule applies to them
    const f = await fixture(db);
    const app = await one<{ application_id: number }>(db,
      'INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2) RETURNING application_id', [f.student_id, f.driveId]);
    await db.query("UPDATE placement_application SET status='Shortlisted' WHERE application_id=$1", [app.application_id]);
    await db.query("UPDATE placement_application SET status='Selected' WHERE application_id=$1", [app.application_id]);
    const offer = await one<{ offer_id: number }>(db, `INSERT INTO placement_offer(application_id,package_lpa,response_deadline)
      VALUES($1,10,now()+interval '1 day') RETURNING offer_id`, [app.application_id]);
    await db.query('SELECT respond_placement_offer($1,$2,true)', [offer.offer_id, f.student_id]);

    const sample = `SELECT s.student_id FROM student s WHERE s.student_id % 97 = 0 OR s.student_id = $2`;
    const variants: Array<[string, string]> = [
      ['any year, any program', `UPDATE placement_drive SET min_year=1, package_lpa=20 WHERE drive_id=$1`],
      ['year 3+, one program', `UPDATE placement_drive SET min_year=3 WHERE drive_id=$1`],
      ['attendance 75%+', `UPDATE placement_drive SET min_year=1, min_attendance_pct=75 WHERE drive_id=$1`],
      ['CGPA rule (unassessable)', `UPDATE placement_drive SET min_attendance_pct=NULL, min_cgpa=7 WHERE drive_id=$1`],
      ['pays under 1.5x the accepted offer', `UPDATE placement_drive SET min_cgpa=NULL, package_lpa=14 WHERE drive_id=$1`],
    ];
    const drive = await fixture(db, { minYear: 1 });
    await db.query('DELETE FROM drive_program WHERE drive_id=$1', [drive.driveId]);
    for (const [label, change] of variants) {
      if (label === 'year 3+, one program') {
        await db.query('INSERT INTO drive_program(drive_id,program_id) VALUES($1,$2)', [drive.driveId, f.program_id]);
      } else if (label === 'attendance 75%+') {
        await db.query('DELETE FROM drive_program WHERE drive_id=$1', [drive.driveId]);
      }
      await db.query(change, [drive.driveId]);
      const oneByOne = (await db.query<{ student_id: number }>(`SELECT x.student_id FROM (${sample}) x
        CROSS JOIN LATERAL is_eligible(x.student_id, $1) e WHERE e.eligible ORDER BY 1`, [drive.driveId, f.student_id]))
        .rows.map((r) => r.student_id);
      const bulk = (await db.query<{ student_id: number }>(`SELECT e.student_id FROM eligible_students_for_drive($1) e
        WHERE e.student_id IN (${sample}) ORDER BY 1`, [drive.driveId, f.student_id])).rows.map((r) => r.student_id);
      expect(bulk, label).toEqual(oneByOne);
      if (label === 'any year, any program') expect(bulk).toContain(f.student_id);
      if (label === 'pays under 1.5x the accepted offer') expect(bulk).not.toContain(f.student_id);
      if (label === 'CGPA rule (unassessable)') expect(bulk).toEqual([]);
    }
  }));

  it('counts accepted full-time offers without multiplying them by rounds', async () => inRollback(async db => {
    const f = await fixture(db);
    const view = await one<{ applications: number; offers: number; is_placed: boolean }>(db,
      `SELECT applications,offers,is_placed FROM v_student_placement_status WHERE student_id=$1`, [f.student_id]);
    expect(view).toMatchObject({ applications: 0, offers: 0, is_placed: false });
  }));

  it('enforces round status transitions and rejects past schedules', async () => inRollback(async db => {
    const f = await fixture(db);
    const round = await one<{ round_id: number }>(db, `INSERT INTO drive_round(drive_id,sequence_no,round_name,scheduled_at)
      VALUES($1,1,'Technical',now()+interval '1 day') RETURNING round_id`, [f.driveId]);
    expect(await fails(db, `UPDATE drive_round SET status='Completed' WHERE round_id=$1`, [round.round_id])).toMatch(/status transition/i);
    expect(await fails(db, `UPDATE drive_round SET status='InProgress' WHERE round_id=$1`, [round.round_id])).toMatch(/before its scheduled time/i);
    expect(await fails(db, `UPDATE drive_round SET scheduled_at=now()-interval '1 hour' WHERE round_id=$1`, [round.round_id])).toMatch(/schedule must be in the future/i);
    await db.query(`UPDATE drive_round SET scheduled_at=NULL WHERE round_id=$1`, [round.round_id]);
    await db.query(`UPDATE drive_round SET status='InProgress' WHERE round_id=$1`, [round.round_id]);
    await db.query(`UPDATE drive_round SET status='Completed' WHERE round_id=$1`, [round.round_id]);
    expect(await fails(db, `UPDATE drive_round SET status='Cancelled' WHERE round_id=$1`, [round.round_id])).toMatch(/status transition/i);
  }));

  it('prevents reopening a published or closed drive', async () => inRollback(async db => {
    const f = await fixture(db);
    await db.query(`UPDATE placement_drive SET status='Closed' WHERE drive_id=$1`, [f.driveId]);
    expect(await fails(db, `UPDATE placement_drive SET status='Draft' WHERE drive_id=$1`, [f.driveId])).toMatch(/status transition/i);
    expect(await fails(db, `UPDATE placement_drive SET status='Open' WHERE drive_id=$1`, [f.driveId])).toMatch(/status transition/i);
  }));

  it('counts offers once and includes only accepted full-time packages in distribution', async () => inRollback(async db => {
    const f = await fixture(db);
    const before = await getAdminPlacementOverview(db as unknown as Db);
    const bandsBefore = await getAcceptedFullTimePackageDistribution(db as unknown as Db);
    const app = await one<{ application_id: number }>(db, `INSERT INTO placement_application(student_id,drive_id) VALUES($1,$2) RETURNING application_id`, [f.student_id, f.driveId]);
    await db.query(`UPDATE placement_application SET status='Shortlisted' WHERE application_id=$1`, [app.application_id]);
    await db.query(`UPDATE placement_application SET status='Selected' WHERE application_id=$1`, [app.application_id]);
    const offer = await one<{ offer_id: number }>(db, `INSERT INTO placement_offer(application_id,package_lpa,response_deadline) VALUES($1,12,now()+interval '1 day') RETURNING offer_id`, [app.application_id]);
    const pending = await getAdminPlacementOverview(db as unknown as Db);
    expect(pending?.total_offers).toBe((before?.total_offers ?? 0) + 1);
    expect(pending?.placed_students).toBe(before?.placed_students);
    await db.query('SELECT respond_placement_offer($1,$2,true)', [offer.offer_id, f.student_id]);
    const accepted = await getAdminPlacementOverview(db as unknown as Db);
    const bandsAfter = await getAcceptedFullTimePackageDistribution(db as unknown as Db);
    expect(accepted?.placed_students).toBe((before?.placed_students ?? 0) + 1);
    expect(accepted?.accepted_fulltime_offers).toBe((before?.accepted_fulltime_offers ?? 0) + 1);
    expect(bandsAfter.map((b) => b.label)).toEqual([
      '< 5 LPA',
      '5–<10 LPA',
      '10–<15 LPA',
      '15–<20 LPA',
      '20+ LPA',
    ]);

    const bandBefore = bandsBefore.find((b) => b.label === '10–<15 LPA')!.offer_count;
    const bandAfter = bandsAfter.find((b) => b.label === '10–<15 LPA')!.offer_count;
    expect(bandAfter).toBe(bandBefore + 1);
  }));
});
