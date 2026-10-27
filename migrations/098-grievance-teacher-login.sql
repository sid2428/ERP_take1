-- 098 · A course grievance goes only to a teacher who can sign in.
-- 094 routed a course grievance to any active teacher of the student's course. If that teacher's
-- portal account is missing or deactivated, notify() skips them (083/092), so the grievance would
-- sit with someone who never sees it and no one would be told. Require an active account, as the
-- app's teacher list (getCourseTeachers) now does; a course whose only teachers cannot sign in is
-- raised as a general grievance, which goes to the admins.
-- Depends on: 094 (trg_grievance_insert, teaches_student).
SET search_path = erp, public;

CREATE OR REPLACE FUNCTION trg_grievance_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_student int;
BEGIN
  IF NEW.status <> 'Open' OR NEW.resolved_at IS NOT NULL OR NEW.resolved_by IS NOT NULL
     OR (NEW.course_id IS NULL AND NEW.assigned_to IS NOT NULL) THEN
    RAISE EXCEPTION 'a new grievance must be Open and unassigned' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.course_id IS NOT NULL THEN
    IF NEW.raised_by_role <> 'student' THEN
      RAISE EXCEPTION 'only students raise a grievance about a course' USING ERRCODE = 'check_violation';
    END IF;
    SELECT student_id INTO v_student FROM app_user WHERE user_id = NEW.raised_by;
    IF NEW.assigned_to IS NULL OR NOT teaches_student(NEW.assigned_to, v_student, NEW.course_id)
       OR NOT EXISTS (SELECT 1 FROM faculty WHERE faculty_id = NEW.assigned_to AND status = 'Active') THEN
      RAISE EXCEPTION 'a course grievance must go to a teacher who teaches you that course this term'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app_user WHERE faculty_id = NEW.assigned_to AND is_active) THEN
      RAISE EXCEPTION 'this teacher cannot receive grievances in the portal; raise it as a general grievance'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.assigned_at := NEW.created_at;
  END IF;
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END $$;
