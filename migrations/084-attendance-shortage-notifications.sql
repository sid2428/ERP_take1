-- 084 · T8 stored attendance-shortage notifications.
-- Install the transition hook after the attendance summary/backfill migrations. The hook is
-- UPDATE-only and therefore does not notify for existing rows or initial summary inserts.
SET search_path = erp, public;

CREATE FUNCTION trg_attendance_shortage_notification() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_course course%ROWTYPE;
  v_user_id int;
  v_recovery int;
  v_text text;
BEGIN
  SELECT c.* INTO v_course FROM course c WHERE c.course_id = NEW.course_id;

  -- Edge-trigger only: a student staying below the threshold cannot be notified on every
  -- summary refresh. The current-session check also excludes historical rows.
  IF NEW.academic_session_id IS DISTINCT FROM current_session_id()
     OR OLD.attendance_pct IS NULL
     OR OLD.attendance_pct < v_course.min_attendance_pct
     OR NEW.attendance_pct IS NULL
     OR NEW.attendance_pct >= v_course.min_attendance_pct THEN
    RETURN NEW;
  END IF;

  SELECT u.user_id INTO v_user_id
  FROM app_user u JOIN student s ON s.student_id = u.student_id
  WHERE u.role = 'student' AND u.student_id = NEW.student_id
    AND u.is_active AND s.status = 'Active';
  IF v_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Match the existing view's recovery calculation. A 100% minimum has no finite count,
  -- so that optional guidance is replaced with a contact-the-office message.
  IF v_course.min_attendance_pct < 100 THEN
    v_recovery := greatest(0, ceil((v_course.min_attendance_pct * NEW.total_sessions
                                   - 100.0 * NEW.attended)
                                  / NULLIF(100 - v_course.min_attendance_pct, 0)))::int;
  END IF;

  v_text := 'Attendance shortage: ' || v_course.course_code || ' — ' || v_course.course_name
         || E'\nYour attendance is ' || to_char(NEW.attendance_pct, 'FM990D00')
         || '%; the minimum is ' || v_course.min_attendance_pct || '%. '
         || CASE WHEN v_recovery IS NOT NULL
                 THEN 'Attend the next ' || v_recovery || ' session'
                   || CASE WHEN v_recovery = 1 THEN '' ELSE 's' END
                   || ' to reach the minimum.'
                 ELSE 'Please contact the academic office for recovery guidance.'
            END;

  CALL notify(v_user_id, 'attendance_shortage', v_text, '/student', 'Academic');
  RETURN NEW;
END $$;

CREATE TRIGGER attendance_shortage_notification
AFTER UPDATE OF total_sessions, attended ON attendance_summary
FOR EACH ROW EXECUTE FUNCTION trg_attendance_shortage_notification();
