-- Group 3 examination logic adapted to the portal's PostgreSQL schema.
-- Keep this migration aligned with data/examination/exam_logic.sql.
SET search_path = erp, public;

CREATE OR REPLACE FUNCTION calculate_cgpa(p_student_id int) RETURNS numeric(4,2)
LANGUAGE sql STABLE SET search_path = erp, public AS $$
  SELECT round((sum(c.credits * r.grade_points) / NULLIF(sum(c.credits), 0))::numeric, 2)::numeric(4,2)
  FROM course_result r
  JOIN course c USING (course_id)
  WHERE r.student_id = p_student_id AND r.is_final_attempt
$$;

CREATE OR REPLACE FUNCTION trg_exam_registration_attendance() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  current_pct numeric(5,2);
  cycle_session_id varchar(10);
BEGIN
  SELECT ec.academic_session_id
    INTO cycle_session_id
  FROM exam_cycle ec
  WHERE ec.exam_cycle_id = NEW.exam_cycle_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'exam cycle % does not exist', NEW.exam_cycle_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT a.attendance_pct
    INTO current_pct
  FROM attendance_summary a
  WHERE a.student_id = NEW.student_id
    AND a.course_id = NEW.course_id
    AND a.academic_session_id = cycle_session_id;

  NEW.attendance_percentage := COALESCE(current_pct, 0);
  IF NEW.registration_status = 'Registered' AND COALESCE(current_pct, 0) < 75 THEN
    RAISE EXCEPTION 'exam registration blocked: attendance is below 75%%'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS exam_registration_attendance ON exam_registration;
CREATE TRIGGER exam_registration_attendance
  BEFORE INSERT OR UPDATE OF student_id, course_id, exam_cycle_id, registration_status
  ON exam_registration FOR EACH ROW EXECUTE FUNCTION trg_exam_registration_attendance();

CREATE OR REPLACE VIEW v_attendance_defaulters_by_division AS
WITH student_attendance AS (
  SELECT student_id, academic_session_id,
         sum(total_sessions)::int AS total_sessions,
         sum(attended)::int AS attended,
         round(100.0 * sum(attended) / NULLIF(sum(total_sessions), 0), 2) AS attendance_pct
  FROM attendance_summary
  WHERE academic_session_id = current_session_id()
  GROUP BY student_id, academic_session_id
)
SELECT d.division_id, d.division_code, d.academic_session_id,
       count(ss.student_id)::int AS student_count,
       count(*) FILTER (WHERE COALESCE(sa.attendance_pct, 0) < 75)::int AS defaulter_count,
       round(100.0 * count(*) FILTER (WHERE COALESCE(sa.attendance_pct, 0) < 75)
         / NULLIF(count(ss.student_id), 0), 2) AS defaulter_percentage
FROM division d
JOIN student_section ss
  ON ss.division_id = d.division_id
 AND ss.academic_session_id = d.academic_session_id
LEFT JOIN student_attendance sa
  ON sa.student_id = ss.student_id
 AND sa.academic_session_id = ss.academic_session_id
WHERE d.academic_session_id = current_session_id()
GROUP BY d.division_id, d.division_code, d.academic_session_id
HAVING count(*) FILTER (WHERE COALESCE(sa.attendance_pct, 0) < 75) > 0;

CREATE OR REPLACE VIEW v_student_cgpa_rank AS
WITH computed_cgpa AS (
  SELECT s.student_id, s.student_number,
         s.first_name || ' ' || s.last_name AS student_name,
         calculate_cgpa(s.student_id) AS cgpa
  FROM student s
)
SELECT student_id, student_number, student_name, cgpa,
       rank() OVER (ORDER BY cgpa DESC) AS cgpa_rank
FROM computed_cgpa
WHERE cgpa IS NOT NULL;
