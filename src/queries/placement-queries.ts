import { query, queryOne } from '../db.js';

export async function getPlacementProfile(studentId: number) {
  return queryOne(`SELECT * FROM student_placement_profile WHERE student_id=$1`, [studentId]);
}

export async function getStudentDrives(studentId: number, filters: { q?: string; type?: string; eligible?: string } = {}) {
  return query(`
    SELECT d.drive_id,d.title,d.role_title,d.drive_type,d.description,d.job_location,d.package_lpa,d.stipend_monthly,
           d.min_year,d.min_cgpa,d.max_active_backlogs,d.min_attendance_pct,d.opens_at,d.deadline,d.drive_date,
           c.company_name,e.eligible,e.reasons,e.assessment_pending,
           EXISTS(SELECT 1 FROM placement_application a WHERE a.drive_id=d.drive_id AND a.student_id=$1) AS applied
      FROM placement_drive d JOIN company c USING(company_id)
      CROSS JOIN LATERAL is_eligible($1,d.drive_id) e
     WHERE d.status IN ('Open','Closed') AND ($2='' OR d.title ILIKE '%'||$2||'%' OR c.company_name ILIKE '%'||$2||'%')
       AND ($3='' OR d.drive_type::text=$3)
       AND ($4='' OR e.eligible=($4='yes'))
     ORDER BY (d.status='Open') DESC,d.deadline,d.drive_id DESC LIMIT 100`,
  [studentId, filters.q ?? '', filters.type ?? '', filters.eligible ?? '']);
}

export async function getStudentApplications(studentId: number) {
  return query(`SELECT a.application_id,a.status,a.applied_at,a.withdrawn_at,d.drive_id,d.title,d.role_title,d.drive_type,
      c.company_name,d.deadline,
      COALESCE((SELECT json_agg(json_build_object('name',r.round_name,'status',rr.result,'date',r.scheduled_at) ORDER BY r.sequence_no)
        FROM drive_round r LEFT JOIN round_result rr ON rr.round_id=r.round_id AND rr.application_id=a.application_id
        WHERE r.drive_id=d.drive_id),'[]'::json) AS rounds,
      o.offer_id,o.status AS offer_status,o.package_lpa,o.stipend_monthly,o.response_deadline
    FROM placement_application a JOIN placement_drive d USING(drive_id) JOIN company c USING(company_id)
    LEFT JOIN placement_offer o USING(application_id) WHERE a.student_id=$1 ORDER BY a.applied_at DESC`, [studentId]);
}

export async function getPlacementDashboard(studentId: number) {
  return queryOne(`SELECT (SELECT count(*)::int FROM placement_drive WHERE status='Open' AND now()>=opens_at AND now()<deadline) AS open_drives,
      (SELECT count(*)::int FROM placement_application WHERE student_id=$1 AND status<>'Withdrawn') AS applications,
      (SELECT count(*)::int FROM placement_application WHERE student_id=$1 AND status IN ('Applied','Shortlisted')) AS in_progress,
      (SELECT count(*)::int FROM placement_offer o JOIN placement_application a USING(application_id)
        WHERE a.student_id=$1 AND o.status='Pending') AS pending_offers,
      (SELECT is_placed FROM v_student_placement_status WHERE student_id=$1) AS is_placed,
      (SELECT (CASE WHEN skills<>'' THEN 20 ELSE 0 END + CASE WHEN resume_url IS NOT NULL THEN 40 ELSE 0 END + CASE WHEN linkedin_url IS NOT NULL THEN 20 ELSE 0 END + CASE WHEN github_url IS NOT NULL OR portfolio_url IS NOT NULL THEN 20 ELSE 0 END)::int FROM student_placement_profile WHERE student_id=$1) AS profile_completion_pct,
      (SELECT count(*)::int FROM placement_drive d CROSS JOIN LATERAL is_eligible($1,d.drive_id) e
        WHERE d.status='Open' AND e.eligible) AS eligible_drives`, [studentId]);
}

export async function getAdminPlacementOverview() {
  return queryOne(`SELECT count(DISTINCT a.student_id) FILTER (WHERE d.drive_type='FullTime' AND o.status='Accepted' AND s.status='Active')::int AS placed_students,
      (SELECT count(*)::int FROM student WHERE status='Active') AS active_students,
      count(DISTINCT o.offer_id) FILTER (WHERE o.status='Accepted' AND d.drive_type='FullTime')::int AS accepted_fulltime_offers,
      count(DISTINCT o.offer_id) FILTER (WHERE o.status='Accepted' AND d.drive_type='Internship')::int AS accepted_internships,
      max(o.package_lpa) FILTER (WHERE o.status='Accepted' AND d.drive_type='FullTime') AS highest_package_lpa,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY o.package_lpa) FILTER (WHERE o.status='Accepted' AND d.drive_type='FullTime') AS median_package_lpa,
      avg(o.package_lpa) FILTER (WHERE o.status='Accepted' AND d.drive_type='FullTime') AS average_package_lpa
    FROM placement_offer o JOIN placement_application a USING(application_id)
    JOIN placement_drive d USING(drive_id) JOIN student s USING(student_id)`);
}

export async function getDepartmentPlacementReport(deptId: string) {
  return query(`SELECT p.program_id,p.program_name,count(DISTINCT s.student_id)::int AS active_students,
      count(DISTINCT s.student_id) FILTER (WHERE ps.is_placed)::int AS placed_students,
      round(100.0*count(DISTINCT s.student_id) FILTER (WHERE ps.is_placed)/NULLIF(count(DISTINCT s.student_id),0),2) AS placed_pct,
      max(ps.best_offer_lpa) AS highest_package_lpa
    FROM program p JOIN student s USING(program_id) JOIN v_student_placement_status ps USING(student_id)
    WHERE p.dept_id=$1 AND s.status='Active' GROUP BY p.program_id,p.program_name ORDER BY p.program_name`, [deptId]);
}

export async function getAdminDrives() {
  return query(`SELECT d.drive_id,d.title,d.role_title,d.drive_type,d.status,d.deadline,d.package_lpa,d.stipend_monthly,
      c.company_name,count(DISTINCT a.application_id)::int AS applicants
    FROM placement_drive d JOIN company c USING(company_id) LEFT JOIN placement_application a USING(drive_id)
    GROUP BY d.drive_id,c.company_name ORDER BY d.created_at DESC LIMIT 100`);
}

export async function getCompanies() {
  return query(`SELECT c.company_id,c.company_name,c.industry,c.website_url,c.is_active,
      count(d.drive_id)::int AS drive_count FROM company c LEFT JOIN placement_drive d USING(company_id)
      GROUP BY c.company_id ORDER BY lower(c.company_name) LIMIT 200`);
}

export async function getDriveApplicants(driveId: number) {
  return query(`SELECT a.application_id,a.status,a.applied_at,s.student_number,s.first_name,s.last_name,
      p.program_name,div.year_of_study,
      COALESCE((SELECT json_agg(json_build_object('round',r.round_name,'result',rr.result,'remarks',rr.private_remarks) ORDER BY r.sequence_no)
        FROM drive_round r LEFT JOIN round_result rr ON rr.round_id=r.round_id AND rr.application_id=a.application_id
        WHERE r.drive_id=a.drive_id),'[]'::json) AS rounds,
      o.offer_id,o.status AS offer_status,o.package_lpa,o.stipend_monthly
    FROM placement_application a JOIN student s USING(student_id) JOIN program p USING(program_id)
    LEFT JOIN student_section ss ON ss.student_id=s.student_id AND ss.academic_session_id=current_session_id()
    LEFT JOIN division div USING(division_id) LEFT JOIN placement_offer o USING(application_id)
    WHERE a.drive_id=$1 ORDER BY a.applied_at`, [driveId]);
}
