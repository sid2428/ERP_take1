-- 090 · Correct the composite-row assignment in the T7 placement notification procedure.
-- Migration 086 is already applied; keep its eligibility and deduplication contract intact.
SET search_path = erp, public;

CREATE OR REPLACE PROCEDURE notify_eligible_placement_drive(p_drive_id int)
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  d placement_drive;
  c_name text;
  recipient record;
  drive_link text;
BEGIN
  SELECT pd.* INTO d FROM placement_drive pd
   WHERE pd.drive_id = p_drive_id AND pd.status = 'Open'
     AND now() >= pd.opens_at AND now() < pd.deadline;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT company_name INTO c_name FROM company WHERE company_id = d.company_id;
  drive_link := '/student/placement/drives/' || p_drive_id::text;
  FOR recipient IN
    SELECT u.user_id
      FROM app_user u JOIN student s USING (student_id)
      CROSS JOIN LATERAL is_eligible(s.student_id, p_drive_id) e
     WHERE u.role = 'student' AND u.is_active AND e.eligible
       AND NOT EXISTS (
         SELECT 1 FROM notification n
         WHERE n.user_id = u.user_id AND n.kind = 'placement' AND n.link = drive_link
       )
  LOOP
    CALL notify(recipient.user_id, 'placement',
      'Placement drive is open: ' || d.title || E'\n' || c_name || ' · ' || d.role_title ||
      E'\nReview details and eligibility before the application deadline.',
      drive_link, 'Placement');
  END LOOP;
END $$;

GRANT EXECUTE ON PROCEDURE notify_eligible_placement_drive(int) TO erp_app;
