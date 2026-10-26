-- 096 · T2 faculty leave decisions delivered through the T8 notification contract.
-- Decision notices share the status update transaction and derive the recipient from the request.
SET search_path = erp, public;

CREATE FUNCTION trg_faculty_leave_notify_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_user_id int;
  v_leave_name text;
  v_outcome text;
  v_text text;
BEGIN
  IF OLD.status <> 'PENDING' OR NEW.status NOT IN ('APPROVED', 'REJECTED') THEN
    RETURN NEW;
  END IF;

  SELECT user_id INTO v_user_id
    FROM app_user
   WHERE faculty_id = NEW.faculty_id AND role = 'faculty' AND is_active;
  IF v_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT leave_name INTO v_leave_name
    FROM faculty_leave_type WHERE leave_type_id = NEW.leave_type_id;
  v_outcome := lower(NEW.status::text);
  v_text := format('Leave request #%s %s', NEW.leave_request_id, v_outcome) || E'\n' ||
    format('%s from %s to %s (%s days) was %s.', v_leave_name, NEW.from_date, NEW.to_date,
      NEW.days_requested, v_outcome) ||
    CASE WHEN NEW.status = 'REJECTED' AND NULLIF(btrim(NEW.decision_remarks), '') IS NOT NULL
      THEN E'\nAdmin note: ' || btrim(NEW.decision_remarks) ELSE '' END;

  CALL notify(v_user_id, 'academic', v_text, '/faculty/leave', 'Academic',
    'faculty-leave:' || NEW.leave_request_id || ':' || v_outcome);
  RETURN NEW;
END $$;

CREATE TRIGGER faculty_leave_notify_decision
  AFTER UPDATE OF status ON faculty_leave_request
  FOR EACH ROW EXECUTE FUNCTION trg_faculty_leave_notify_decision();
