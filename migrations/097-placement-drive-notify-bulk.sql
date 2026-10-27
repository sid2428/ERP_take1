-- 097 · Notify a placement drive's eligible students in one set-based statement.
-- 091's procedure called is_eligible() and notify() once per student: about 40,000 calls when a
-- drive is open to every year, which took ~17 s locally and exceeded erp_app's 15 s
-- statement_timeout (007), so opening or publishing such a drive failed.
-- eligible_students_for_drive() applies the same rules as is_eligible() (085) to all students at
-- once; the notification rows match what notify() (092) writes. Keep the two functions in step:
-- tests/db/placement.test.ts compares them.
-- Depends on: 084/085 (placement, is_eligible), 091 (notify_eligible_placement_drive), 092 (notify).
SET search_path = erp, public;

CREATE FUNCTION eligible_students_for_drive(p_drive_id int) RETURNS TABLE(student_id int)
LANGUAGE sql STABLE SET search_path = erp, public AS $$
  WITH d AS (
    SELECT * FROM placement_drive WHERE drive_id = p_drive_id
  ), att AS (               -- read the attendance view only when the drive sets a minimum
    SELECT a.student_id, round(avg(a.attendance_pct), 2) AS attendance_pct
      FROM v_student_attendance_by_course a
     WHERE a.academic_session_id = current_session_id()
       AND EXISTS (SELECT 1 FROM d WHERE d.min_attendance_pct IS NOT NULL)
     GROUP BY a.student_id
  ), accepted AS (
    SELECT a.student_id, max(o.package_lpa) AS accepted_package
      FROM placement_offer o JOIN placement_application a USING (application_id)
      JOIN placement_drive od USING (drive_id)
     WHERE od.drive_type = 'FullTime' AND o.status = 'Accepted'
     GROUP BY a.student_id
  )
  SELECT DISTINCT s.student_id
    FROM d CROSS JOIN student s
    LEFT JOIN student_section ss ON ss.student_id = s.student_id AND ss.academic_session_id = current_session_id()
    LEFT JOIN division div ON div.division_id = ss.division_id
    LEFT JOIN att ON att.student_id = s.student_id
    LEFT JOIN accepted acc ON acc.student_id = s.student_id
   WHERE d.status = 'Open' AND s.status = 'Active' AND now() >= d.opens_at AND now() < d.deadline
     AND div.year_of_study IS NOT NULL AND NOT COALESCE(div.year_of_study < d.min_year, false)
     AND (NOT EXISTS (SELECT 1 FROM drive_program dp WHERE dp.drive_id = d.drive_id)
          OR EXISTS (SELECT 1 FROM drive_program dp WHERE dp.drive_id = d.drive_id AND dp.program_id = s.program_id))
     AND d.min_cgpa IS NULL AND d.max_active_backlogs IS NULL      -- these assessments are unavailable
     AND (d.min_attendance_pct IS NULL OR att.attendance_pct >= d.min_attendance_pct)
     AND NOT COALESCE(acc.student_id IS NOT NULL AND d.drive_type = 'FullTime'
                      AND d.package_lpa < acc.accepted_package * 1.5, false)
$$;

GRANT EXECUTE ON FUNCTION eligible_students_for_drive(int) TO erp_app;

CREATE OR REPLACE PROCEDURE notify_eligible_placement_drive(p_drive_id int)
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  d placement_drive;
  c_name text;
  drive_link text;
  v_text text;
BEGIN
  SELECT pd.* INTO d FROM placement_drive pd
   WHERE pd.drive_id = p_drive_id AND pd.status = 'Open' AND now() >= pd.opens_at AND now() < pd.deadline;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT company_name INTO c_name FROM company WHERE company_id = d.company_id;
  drive_link := '/student/placement/drives/' || p_drive_id::text;
  v_text := 'Placement drive is open: ' || d.title || E'\n' || c_name || ' · ' || d.role_title ||
            E'\nReview details and eligibility before the application deadline.';

  -- same title, text, category and expiry as notify(); students already told about this drive are skipped
  INSERT INTO notification (user_id, kind, title, text, category, link, expires_at)
  SELECT u.user_id, 'placement',
         btrim(CASE WHEN strpos(v_text, E'\n') BETWEEN 2 AND 151 THEN split_part(v_text, E'\n', 1) ELSE 'Placement' END),
         btrim(v_text), 'Placement', drive_link, now() + interval '60 days'
    FROM eligible_students_for_drive(p_drive_id) e
    JOIN app_user u ON u.student_id = e.student_id AND u.role = 'student' AND u.is_active
   WHERE NOT EXISTS (SELECT 1 FROM notification n
                      WHERE n.user_id = u.user_id AND n.kind = 'placement' AND n.link = drive_link);
END $$;

GRANT EXECUTE ON PROCEDURE notify_eligible_placement_drive(int) TO erp_app;
