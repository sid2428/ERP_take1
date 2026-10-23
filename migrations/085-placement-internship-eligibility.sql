-- An accepted full-time offer restricts only additional full-time applications.
-- Internship pay uses a different unit and must not be compared to annual LPA.
SET search_path = erp, public;

CREATE OR REPLACE FUNCTION is_eligible(p_student_id int, p_drive_id int)
RETURNS TABLE(eligible boolean, reasons text[], assessment_pending boolean)
LANGUAGE sql STABLE SET search_path = erp, public AS $$
  WITH facts AS (
    SELECT d.*, s.program_id, s.status AS student_status, div.year_of_study,
           EXISTS (SELECT 1 FROM drive_program dp WHERE dp.drive_id=d.drive_id) AS has_program_filter,
           EXISTS (SELECT 1 FROM drive_program dp WHERE dp.drive_id=d.drive_id AND dp.program_id=s.program_id) AS program_match,
           (SELECT round(avg(a.attendance_pct),2) FROM v_student_attendance_by_course a
             WHERE a.student_id=p_student_id AND a.academic_session_id=current_session_id()) AS attendance_pct,
           EXISTS (SELECT 1 FROM placement_offer o JOIN placement_application a USING(application_id)
             JOIN placement_drive od USING(drive_id)
             WHERE a.student_id=p_student_id AND od.drive_type='FullTime' AND o.status='Accepted') AS has_accepted_fulltime,
           (SELECT max(o.package_lpa) FROM placement_offer o JOIN placement_application a USING(application_id)
             JOIN placement_drive od USING(drive_id)
             WHERE a.student_id=p_student_id AND od.drive_type='FullTime' AND o.status='Accepted') AS accepted_package
      FROM placement_drive d CROSS JOIN student s
      LEFT JOIN program p ON p.program_id=s.program_id
      LEFT JOIN student_section ss ON ss.student_id=s.student_id AND ss.academic_session_id=current_session_id()
      LEFT JOIN division div ON div.division_id=ss.division_id
     WHERE s.student_id=p_student_id AND d.drive_id=p_drive_id
  ), checked AS (
    SELECT f.*,
      array_remove(ARRAY[
        CASE WHEN status <> 'Open' THEN 'This drive is not open' END,
        CASE WHEN student_status <> 'Active' THEN 'Only active students may apply' END,
        CASE WHEN now() < opens_at THEN 'Applications have not opened' END,
        CASE WHEN now() >= deadline THEN 'The application deadline has passed' END,
        CASE WHEN year_of_study IS NULL THEN 'Current academic year is unavailable' WHEN year_of_study < min_year THEN 'Your year of study does not meet this drive''s requirement' END,
        CASE WHEN has_program_filter AND NOT program_match THEN 'Your program is not eligible for this drive' END,
        CASE WHEN min_cgpa IS NOT NULL THEN 'CGPA assessment is unavailable' END,
        CASE WHEN max_active_backlogs IS NOT NULL THEN 'Backlog assessment is unavailable' END,
        CASE WHEN min_attendance_pct IS NOT NULL AND attendance_pct IS NULL THEN 'Attendance assessment is unavailable' WHEN min_attendance_pct IS NOT NULL AND attendance_pct < min_attendance_pct THEN 'Minimum attendance requirement is not met' END,
        CASE WHEN has_accepted_fulltime AND drive_type='FullTime' AND package_lpa < accepted_package * 1.5 THEN 'An accepted full-time offer restricts applications to full-time drives paying at least 1.5x that package' END
      ]::text[], NULL) AS failed,
      (min_cgpa IS NOT NULL OR max_active_backlogs IS NOT NULL) AS pending
    FROM facts f
  )
  SELECT cardinality(failed)=0, failed, pending FROM checked
$$;
