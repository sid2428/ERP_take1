import { query, queryOne, type Db } from '../db.js';

export async function getPlacementProfile(studentId: number) {
  return queryOne(`SELECT * FROM student_placement_profile WHERE student_id=$1`, [studentId]);
}

export async function getStudentDrives(
  studentId: number,
  filters: { q?: string; type?: string; eligible?: string } = {},
  pagination: { page: number; pageSize: number } = { page: 1, pageSize: 20 },
  db?: Db,
) {
  const params = [studentId, filters.q ?? '', filters.type ?? '', filters.eligible ?? ''];
  const where = `d.status IN ('Open','Closed') AND ($2='' OR d.title ILIKE '%'||$2||'%' OR c.company_name ILIKE '%'||$2||'%')
       AND ($3='' OR d.drive_type::text=$3)
       AND ($4='' OR e.eligible=($4='yes'))`;
  const totals = await query<{ total: number }>(`
    SELECT count(*)::int AS total
      FROM placement_drive d JOIN company c USING(company_id)
      CROSS JOIN LATERAL is_eligible($1,d.drive_id) e
     WHERE ${where}`,
  params, db);
  const total = totals[0]?.total ?? 0;
  const totalPages = Math.ceil(total / pagination.pageSize);
  const page = totalPages === 0 ? 1 : Math.min(Math.max(1, pagination.page), totalPages);
  const drives = await query(`
    SELECT d.drive_id,d.title,d.role_title,d.drive_type,d.description,d.job_location,d.package_lpa,d.stipend_monthly,
           d.min_year,d.min_cgpa,d.max_active_backlogs,d.min_attendance_pct,d.opens_at,d.deadline,d.drive_date,
           c.company_name,e.eligible,e.reasons,e.assessment_pending,
           EXISTS(SELECT 1 FROM placement_application a WHERE a.drive_id=d.drive_id AND a.student_id=$1) AS applied
      FROM placement_drive d JOIN company c USING(company_id)
      CROSS JOIN LATERAL is_eligible($1,d.drive_id) e
     WHERE ${where}
     ORDER BY (d.status='Open') DESC,d.deadline,d.drive_id DESC LIMIT $5 OFFSET $6`,
  [...params, pagination.pageSize, (page - 1) * pagination.pageSize], db);
  return { drives, page, pageSize: pagination.pageSize, total, totalPages };
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

export async function getAdminPlacementOverview(db?: Db, deptId?: string, expectedGraduationYear?: number) {
  return queryOne(`WITH branch_students AS (
      SELECT s.student_id,s.status FROM student s JOIN program p USING(program_id)
       WHERE ($1::varchar IS NULL OR p.dept_id=$1)
         AND ($2::smallint IS NULL OR s.expected_graduation_year=$2)
    ), offer_stats AS (
      SELECT count(DISTINCT o.offer_id)::int AS total_offers,
             count(DISTINCT o.offer_id) FILTER (WHERE o.status='Accepted' AND d.drive_type='FullTime')::int AS accepted_fulltime_offers,
             count(DISTINCT o.offer_id) FILTER (WHERE o.status='Accepted' AND d.drive_type='Internship')::int AS accepted_internships,
             count(DISTINCT s.student_id) FILTER (WHERE d.drive_type='FullTime' AND o.status='Accepted' AND s.status='Active')::int AS placed_students,
             max(o.package_lpa) FILTER (WHERE o.status='Accepted' AND d.drive_type='FullTime') AS highest_package_lpa,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY o.package_lpa) FILTER (WHERE o.status='Accepted' AND d.drive_type='FullTime') AS median_package_lpa,
             avg(o.package_lpa) FILTER (WHERE o.status='Accepted' AND d.drive_type='FullTime') AS average_package_lpa
        FROM placement_offer o JOIN placement_application a USING(application_id)
        JOIN placement_drive d USING(drive_id) JOIN branch_students s USING(student_id)
    )
    SELECT (SELECT count(*) FILTER (WHERE s.status='Active')::int FROM branch_students s) AS active_students,
           os.placed_students,os.total_offers,os.accepted_fulltime_offers,os.accepted_internships,
           os.highest_package_lpa,os.median_package_lpa,os.average_package_lpa
      FROM offer_stats os`,
  [deptId ?? null, expectedGraduationYear ?? null], db);
}

export async function getAdminDepartmentPlacementStats(deptId?: string, db?: Db, expectedGraduationYear?: number) {
  return query<{
    dept_id: string;
    dept_name: string;
    active_students: number;
    placed_students: number;
    placed_pct: number;
    highest_package_lpa: number | null;
    total_offers: number;
    accepted_fulltime_offers: number;
    accepted_internships: number;
    verified_cohort_students: number;
    unverified_cohort_students: number;
  }>(`WITH branch_students AS (
      SELECT d.dept_id,d.dept_name,s.student_id,s.status,s.expected_graduation_year
        FROM department d
        LEFT JOIN program p USING(dept_id)
        LEFT JOIN student s ON s.program_id=p.program_id
    ), student_stats AS (
      SELECT dept_id,dept_name,
             count(DISTINCT student_id) FILTER (WHERE status='Active'
               AND ($2::smallint IS NULL OR expected_graduation_year=$2))::int AS active_students,
             count(DISTINCT student_id) FILTER (WHERE status='Active' AND expected_graduation_year IS NOT NULL
               AND ($2::smallint IS NULL OR expected_graduation_year=$2))::int AS verified_cohort_students,
             count(DISTINCT student_id) FILTER (WHERE status='Active' AND expected_graduation_year IS NULL)::int AS unverified_cohort_students
        FROM branch_students
       GROUP BY dept_id,dept_name
    ), offer_stats AS (
      SELECT p.dept_id,
             count(DISTINCT o.offer_id)::int AS total_offers,
             count(DISTINCT o.offer_id) FILTER (WHERE d.drive_type='FullTime' AND o.status='Accepted')::int AS accepted_fulltime_offers,
             count(DISTINCT o.offer_id) FILTER (WHERE d.drive_type='Internship' AND o.status='Accepted')::int AS accepted_internships,
             count(DISTINCT s.student_id) FILTER (WHERE d.drive_type='FullTime' AND o.status='Accepted' AND s.status='Active')::int AS placed_students,
             max(o.package_lpa) FILTER (WHERE d.drive_type='FullTime' AND o.status='Accepted') AS highest_package_lpa
        FROM placement_offer o
        JOIN placement_application a USING(application_id)
        JOIN placement_drive d USING(drive_id)
        JOIN student s USING(student_id)
        JOIN program p USING(program_id)
       WHERE $2::smallint IS NULL OR s.expected_graduation_year=$2
       GROUP BY p.dept_id
    )
    SELECT ss.dept_id,ss.dept_name,ss.active_students,
           COALESCE(os.placed_students,0)::int AS placed_students,
           COALESCE(round(100.0*os.placed_students/NULLIF(ss.active_students,0),2),0)::float8 AS placed_pct,
           os.highest_package_lpa,COALESCE(os.total_offers,0)::int AS total_offers,
           COALESCE(os.accepted_fulltime_offers,0)::int AS accepted_fulltime_offers,
           COALESCE(os.accepted_internships,0)::int AS accepted_internships,
           ss.verified_cohort_students,ss.unverified_cohort_students
      FROM student_stats ss
      LEFT JOIN offer_stats os USING(dept_id)
     WHERE $1::varchar IS NULL OR ss.dept_id=$1
     ORDER BY ss.dept_name`, [deptId ?? null, expectedGraduationYear ?? null], db);
}

/** Accepted full-time packages in fixed LPA bands; empty bands remain present with count zero. */
export async function getAcceptedFullTimePackageDistribution(db?: Db, deptId?: string, expectedGraduationYear?: number) {
  return query<{ label: string; offer_count: number }>(`WITH bands(sort_order,label,minimum_lpa,maximum_lpa) AS (VALUES
      (1,'< 5 LPA',0::numeric,5::numeric),(2,'5–<10 LPA',5::numeric,10::numeric),
      (3,'10–<15 LPA',10::numeric,15::numeric),(4,'15–<20 LPA',15::numeric,20::numeric),
      (5,'20+ LPA',20::numeric,NULL::numeric)
    )
    SELECT b.label,count(o.offer_id)::int AS offer_count FROM bands b LEFT JOIN placement_offer o
      ON o.status='Accepted' AND o.package_lpa IS NOT NULL AND o.package_lpa>=b.minimum_lpa
      AND (b.maximum_lpa IS NULL OR o.package_lpa<b.maximum_lpa)
      AND EXISTS(SELECT 1 FROM placement_application a JOIN placement_drive d USING(drive_id)
        JOIN student s USING(student_id) JOIN program p USING(program_id)
        WHERE a.application_id=o.application_id AND d.drive_type='FullTime'
          AND ($1::varchar IS NULL OR p.dept_id=$1)
          AND ($2::smallint IS NULL OR s.expected_graduation_year=$2))
    GROUP BY b.sort_order,b.label ORDER BY b.sort_order`, [deptId ?? null, expectedGraduationYear ?? null], db);
}

export async function getCompanyPlacementOffers(deptId?: string, db?: Db, expectedGraduationYear?: number) {
  return query(`SELECT c.company_id,c.company_name,count(o.offer_id)::int AS total_offers,
      count(o.offer_id) FILTER (WHERE o.status='Accepted' AND d.drive_type='FullTime')::int AS accepted_fulltime,
      count(o.offer_id) FILTER (WHERE o.status='Accepted' AND d.drive_type='Internship')::int AS accepted_internships
    FROM company c JOIN placement_drive d USING(company_id)
    JOIN placement_application a USING(drive_id) JOIN placement_offer o USING(application_id)
    JOIN student s USING(student_id) JOIN program p USING(program_id)
    WHERE ($1::varchar IS NULL OR p.dept_id=$1)
      AND ($2::smallint IS NULL OR s.expected_graduation_year=$2)
    GROUP BY c.company_id,c.company_name ORDER BY total_offers DESC,lower(c.company_name)`,
  [deptId ?? null, expectedGraduationYear ?? null], db);
}

export async function getAdminExpectedGraduationYears(deptId?: string, db?: Db) {
  return query<{ expected_graduation_year: number }>(`SELECT DISTINCT s.expected_graduation_year
    FROM student s JOIN program p USING(program_id)
    WHERE s.status='Active' AND s.expected_graduation_year IS NOT NULL
      AND ($1::varchar IS NULL OR p.dept_id=$1)
    ORDER BY s.expected_graduation_year`, [deptId ?? null], db);
}

export async function getAdminBatchPlacementStats(db?: Db, deptId?: string, expectedGraduationYear?: number) {
  return query<{
    expected_graduation_year: number;
    active_students: number;
    placed_students: number;
    placed_pct: number;
    total_offers: number;
    accepted_fulltime_offers: number;
    accepted_internships: number;
    highest_package_lpa: number | null;
    average_package_lpa: number | null;
    median_package_lpa: number | null;
  }>(`WITH active_batches AS (
      SELECT s.expected_graduation_year,count(DISTINCT s.student_id)::int AS active_students
      FROM student s JOIN program p USING(program_id)
      WHERE s.status='Active' AND s.expected_graduation_year IS NOT NULL
        AND ($1::varchar IS NULL OR p.dept_id=$1)
        AND ($2::smallint IS NULL OR s.expected_graduation_year=$2)
      GROUP BY s.expected_graduation_year
    ), offer_stats AS (
      SELECT s.expected_graduation_year,
             count(DISTINCT o.offer_id)::int AS total_offers,
             count(DISTINCT o.offer_id) FILTER (WHERE d.drive_type='FullTime' AND o.status='Accepted')::int AS accepted_fulltime_offers,
             count(DISTINCT o.offer_id) FILTER (WHERE d.drive_type='Internship' AND o.status='Accepted')::int AS accepted_internships,
             count(DISTINCT s.student_id) FILTER (WHERE s.status='Active' AND d.drive_type='FullTime' AND o.status='Accepted')::int AS placed_students,
             max(o.package_lpa) FILTER (WHERE d.drive_type='FullTime' AND o.status='Accepted' AND o.package_lpa IS NOT NULL) AS highest_package_lpa,
             round(avg(o.package_lpa) FILTER (WHERE d.drive_type='FullTime' AND o.status='Accepted' AND o.package_lpa IS NOT NULL),2) AS average_package_lpa,
             round((percentile_cont(0.5) WITHIN GROUP (ORDER BY o.package_lpa)
               FILTER (WHERE d.drive_type='FullTime' AND o.status='Accepted' AND o.package_lpa IS NOT NULL))::numeric,2) AS median_package_lpa
      FROM placement_offer o
      JOIN placement_application a USING(application_id)
      JOIN placement_drive d USING(drive_id)
      JOIN student s USING(student_id)
      JOIN program p USING(program_id)
      WHERE s.expected_graduation_year IS NOT NULL
        AND ($1::varchar IS NULL OR p.dept_id=$1)
        AND ($2::smallint IS NULL OR s.expected_graduation_year=$2)
      GROUP BY s.expected_graduation_year
    )
    SELECT ab.expected_graduation_year,ab.active_students,
           COALESCE(os.placed_students,0)::int AS placed_students,
           COALESCE(round(100.0*os.placed_students/NULLIF(ab.active_students,0),2),0)::float8 AS placed_pct,
           COALESCE(os.total_offers,0)::int AS total_offers,
           COALESCE(os.accepted_fulltime_offers,0)::int AS accepted_fulltime_offers,
           COALESCE(os.accepted_internships,0)::int AS accepted_internships,
           os.highest_package_lpa,os.average_package_lpa,os.median_package_lpa
    FROM active_batches ab LEFT JOIN offer_stats os USING(expected_graduation_year)
    ORDER BY ab.expected_graduation_year`, [deptId ?? null, expectedGraduationYear ?? null], db);
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
