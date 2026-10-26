-- 094 · Grievances go to the course teacher.
-- A student who raises a grievance about one of their courses picks the course; the grievance is
-- assigned straight to a teacher who teaches them that course this term (the app picks the theory
-- teacher by default). That teacher replies and closes it as Resolved or Rejected, which locks it.
-- Only an admin can unlock (reopen) a locked grievance, and must give a reason.
-- General grievances (no course) and grievances raised by faculty still go to the admin (080).
-- Depends on: 004 (teaching_assignment, v_assignment_roster), 080 (grievances), 092 (notify event keys).
SET search_path = erp, public;

ALTER TABLE grievance ADD COLUMN course_id int REFERENCES course;
ALTER TABLE grievance ADD CONSTRAINT grievance_course_by_student CHECK (course_id IS NULL OR raised_by_role = 'student');
CREATE INDEX ON grievance (course_id);

-- The outcome note of a close, or the reason for an unlock, kept with the status change so the
-- history survives a reopen (which clears grievance.resolution_note).
ALTER TABLE grievance_status_log ADD COLUMN note text CHECK (length(note) <= 2000);
UPDATE grievance_status_log l SET note = g.resolution_note
  FROM grievance g
 WHERE g.grievance_id = l.grievance_id AND g.status IN ('Resolved', 'Rejected') AND l.to_status = g.status;

-- Does this faculty member teach this student this course in the current term?
CREATE FUNCTION teaches_student(p_faculty_id int, p_student_id int, p_course_id int) RETURNS boolean
LANGUAGE sql STABLE SET search_path = erp, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM teaching_assignment ta JOIN v_assignment_roster r USING (assignment_id)
    WHERE ta.faculty_id = p_faculty_id AND ta.course_id = p_course_id AND r.student_id = p_student_id
      AND ta.academic_session_id = current_session_id())
$$;

-- A general grievance starts Open and unassigned; a course grievance starts Open and already with
-- one of the student's teachers for that course.
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
    NEW.assigned_at := NEW.created_at;
  END IF;
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END $$;

-- Workflow rules (080) plus: the assigned teacher may close a course grievance, and an admin may
-- unlock a closed grievance (Resolved/Rejected -> In progress), which clears the decision.
CREATE OR REPLACE FUNCTION trg_grievance_workflow() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_closed boolean := OLD.status IN ('Resolved', 'Rejected');
  v_unlock boolean;
  v_assignee_user int;
BEGIN
  v_unlock := v_closed AND NEW.status = 'In progress'
    AND EXISTS (SELECT 1 FROM app_user WHERE user_id = acting_user_id() AND role = 'admin' AND is_active);
  IF v_closed AND NOT v_unlock THEN
    RAISE EXCEPTION 'grievance % is already %; only an admin can unlock it', OLD.grievance_id, lower(OLD.status::text)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.raised_by <> OLD.raised_by OR NEW.raised_by_role <> OLD.raised_by_role OR NEW.subject <> OLD.subject
     OR NEW.description <> OLD.description OR NEW.created_at <> OLD.created_at
     OR NEW.course_id IS DISTINCT FROM OLD.course_id THEN
    RAISE EXCEPTION 'who raised a grievance and what they wrote cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF v_unlock THEN
    IF NEW.category <> OLD.category OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
      RAISE EXCEPTION 'unlocking only reopens a grievance; change it afterwards' USING ERRCODE = 'check_violation';
    END IF;
    NEW.resolution_note := NULL;     -- the status log keeps the old decision
    NEW.resolved_at := NULL;
    NEW.resolved_by := NULL;
  END IF;

  -- Open -> In progress | Resolved | Rejected;  In progress -> Resolved | Rejected;  closed -> In progress (unlock)
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'Open' AND NEW.status IN ('In progress', 'Resolved', 'Rejected'))
    OR (OLD.status = 'In progress' AND NEW.status IN ('Resolved', 'Rejected'))
    OR v_unlock) THEN
    RAISE EXCEPTION 'a grievance cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    IF NEW.assigned_to IS NULL THEN
      IF NEW.course_id IS NOT NULL THEN
        RAISE EXCEPTION 'a course grievance always has a teacher; reassign it instead' USING ERRCODE = 'check_violation';
      END IF;
      NEW.assigned_at := NULL;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM faculty WHERE faculty_id = NEW.assigned_to AND status = 'Active') THEN
        RAISE EXCEPTION 'grievances can only be assigned to active faculty' USING ERRCODE = 'check_violation';
      END IF;
      SELECT user_id INTO v_assignee_user FROM app_user WHERE faculty_id = NEW.assigned_to;
      IF v_assignee_user = NEW.raised_by THEN
        RAISE EXCEPTION 'a grievance cannot be assigned to the person who raised it' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.assigned_at IS NOT DISTINCT FROM OLD.assigned_at THEN NEW.assigned_at := now(); END IF;
      IF NEW.status = 'Open' THEN NEW.status := 'In progress'; END IF;    -- assigning starts the work
    END IF;
  END IF;

  IF NEW.status IN ('Resolved', 'Rejected') THEN
    NEW.resolved_at := COALESCE(NEW.resolved_at, now());
    NEW.resolved_by := COALESCE(NEW.resolved_by, acting_user_id());
    IF NOT EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = NEW.resolved_by AND u.is_active
                     AND (u.role = 'admin' OR (NEW.course_id IS NOT NULL AND u.faculty_id = NEW.assigned_to))) THEN
      IF NEW.course_id IS NULL THEN
        RAISE EXCEPTION 'only an admin can close a grievance' USING ERRCODE = 'check_violation';
      END IF;
      RAISE EXCEPTION 'only the assigned teacher or an admin can close this grievance' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.resolved_at IS NOT NULL OR NEW.resolved_by IS NOT NULL THEN
    RAISE EXCEPTION 'only a closed grievance has a resolution' USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := GREATEST(now(), NEW.resolved_at, NEW.assigned_at);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trg_grievance_log_status() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO grievance_status_log (grievance_id, from_status, to_status, changed_by, changed_at)
    VALUES (NEW.grievance_id, NULL, NEW.status, NEW.raised_by, NEW.created_at);
  ELSIF NEW.status <> OLD.status THEN
    INSERT INTO grievance_status_log (grievance_id, from_status, to_status, changed_by, changed_at, note)
    VALUES (NEW.grievance_id, OLD.status, NEW.status, COALESCE(acting_user_id(), NEW.resolved_by), NEW.updated_at,
            CASE WHEN NEW.status IN ('Resolved', 'Rejected') THEN NEW.resolution_note
                 WHEN OLD.status IN ('Resolved', 'Rejected') THEN NULLIF(current_setting('erp.status_note', true), '') END);
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------
-- Close as Resolved or Rejected with a note: an admin (any grievance) or the assigned teacher
-- (course grievances). Closing locks the grievance.
DROP PROCEDURE resolve_grievance(int, int, grievance_status, text);
CREATE PROCEDURE resolve_grievance(p_grievance_id int, p_user_id int, p_outcome grievance_status, p_note text)
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  g grievance%ROWTYPE;
BEGIN
  SELECT * INTO g FROM grievance WHERE grievance_id = p_grievance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown grievance %', p_grievance_id USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = p_user_id AND u.is_active
                   AND (u.role = 'admin' OR (g.course_id IS NOT NULL AND u.faculty_id = g.assigned_to))) THEN
    IF g.course_id IS NULL THEN
      RAISE EXCEPTION 'only an admin can close a grievance' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RAISE EXCEPTION 'only the assigned teacher or an admin can close this grievance' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_outcome NOT IN ('Resolved', 'Rejected') THEN
    RAISE EXCEPTION 'a grievance is closed as Resolved or Rejected, not %', p_outcome USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('erp.user_id', p_user_id::text, true);
  UPDATE grievance SET status = p_outcome, resolution_note = btrim(p_note), resolved_by = p_user_id
   WHERE grievance_id = p_grievance_id;
END $$;

-- An admin reopens a locked (Resolved/Rejected) grievance; it goes back to In progress with the
-- same teacher, and the reason is logged with the status change.
CREATE PROCEDURE unlock_grievance(p_grievance_id int, p_admin_user_id int, p_reason text)
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_user WHERE user_id = p_admin_user_id AND role = 'admin' AND is_active) THEN
    RAISE EXCEPTION 'only an admin can unlock a grievance' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) NOT BETWEEN 5 AND 2000 THEN
    RAISE EXCEPTION 'give a reason of 5 to 2,000 characters for unlocking' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('erp.user_id', p_admin_user_id::text, true);
  PERFORM set_config('erp.status_note', btrim(p_reason), true);
  UPDATE grievance SET status = 'In progress'
   WHERE grievance_id = p_grievance_id AND status IN ('Resolved', 'Rejected');
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM grievance WHERE grievance_id = p_grievance_id) THEN
      RAISE EXCEPTION 'grievance % is not locked', p_grievance_id USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'unknown grievance %', p_grievance_id USING ERRCODE = 'no_data_found';
  END IF;
  PERFORM set_config('erp.status_note', '', true);
END $$;

-- ---------------------------------------------------------------------------------------
-- Notifications (092 contract): a course grievance goes to its teacher, not to the admins.
CREATE OR REPLACE FUNCTION trg_grievance_notify_new() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_name text;
  v_admin int;
  v_teacher int;
  v_course text;
BEGIN
  SELECT display_name || ' (' || login_id || ')' INTO v_name FROM v_user_profile WHERE user_id = NEW.raised_by;
  IF NEW.course_id IS NOT NULL THEN
    SELECT user_id INTO v_teacher FROM app_user WHERE faculty_id = NEW.assigned_to;
    SELECT course_code || ' ' || course_name INTO v_course FROM course WHERE course_id = NEW.course_id;
    CALL notify(v_teacher, 'grievance',
      ('New grievance #' || NEW.grievance_id || ' on ' || v_course || ': ' || NEW.subject || E'\n' ||
       v_name || ' raised a ' || lower(NEW.category::text) || ' grievance for you. Reply, then resolve or reject it.'),
      grievance_link('faculty', NEW.grievance_id), grievance_notice_category(NEW.category),
      'grievance:' || NEW.grievance_id || ':created');
    RETURN NULL;
  END IF;
  FOR v_admin IN SELECT user_id FROM app_user WHERE role = 'admin' AND is_active LOOP
    CALL notify(v_admin, 'grievance',
      ('New grievance #' || NEW.grievance_id || ': ' || NEW.subject || E'\n' ||
       v_name || ' raised a ' || lower(NEW.category::text) || ' grievance. Assign it or reply from the grievance queue.'),
      grievance_link('admin', NEW.grievance_id), grievance_notice_category(NEW.category),
      'grievance:' || NEW.grievance_id || ':created');
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION trg_grievance_notify_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_raiser_link text := grievance_link(NEW.raised_by_role, NEW.grievance_id);
  v_cat notice_category := grievance_notice_category(NEW.category);
  v_assignee int;
  v_assignee_name text;
  v_handler text;
  v_event_key text;
  v_reason text;
BEGIN
  SELECT u.user_id, f.first_name || ' ' || f.last_name INTO v_assignee, v_assignee_name
  FROM faculty f LEFT JOIN app_user u ON u.faculty_id = f.faculty_id WHERE f.faculty_id = NEW.assigned_to;
  v_handler := CASE WHEN NEW.course_id IS NOT NULL THEN v_assignee_name ELSE 'The academic office' END;

  IF NEW.assigned_to IS NOT NULL AND NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    v_event_key := 'grievance:' || NEW.grievance_id || ':assignment:' || NEW.assigned_to || ':' || NEW.assigned_at;
    CALL notify(v_assignee, 'grievance',
      ('Grievance #' || NEW.grievance_id || ' assigned to you' || E'\n' ||
       'The academic office asked you to help with "' || NEW.subject || '". Read it and reply in the conversation.'),
      grievance_link('faculty', NEW.grievance_id), v_cat, v_event_key);
    CALL notify(NEW.raised_by, 'grievance',
      ('Your grievance #' || NEW.grievance_id || ' is being handled' || E'\n' ||
       v_assignee_name || ' has been asked to help with "' || NEW.subject || '". You can talk to them in the replies.'),
      v_raiser_link, v_cat, v_event_key);
  ELSIF NEW.status = 'In progress' AND OLD.status = 'Open' THEN
    v_event_key := 'grievance:' || NEW.grievance_id || ':in-progress:' || NEW.updated_at;
    CALL notify(NEW.raised_by, 'grievance',
      ('Your grievance #' || NEW.grievance_id || ' is in progress' || E'\n' ||
       v_handler || ' is looking into "' || NEW.subject || '".'), v_raiser_link, v_cat, v_event_key);
  END IF;

  IF NEW.status IN ('Resolved', 'Rejected') AND OLD.status NOT IN ('Resolved', 'Rejected') THEN
    -- resolved_at keeps the key unique when a grievance is closed again after an unlock
    v_event_key := 'grievance:' || NEW.grievance_id || ':' || lower(NEW.status::text) || ':' || NEW.resolved_at;
    CALL notify(NEW.raised_by, 'grievance',
      ('Your grievance #' || NEW.grievance_id || ' was ' || lower(NEW.status::text) || E'\n' ||
       '"' || NEW.subject || '": ' || NEW.resolution_note), v_raiser_link, v_cat, v_event_key);
    IF v_assignee IS NOT NULL AND v_assignee IS DISTINCT FROM NEW.resolved_by THEN
      CALL notify(v_assignee, 'grievance',
        ('Grievance #' || NEW.grievance_id || ' was ' || lower(NEW.status::text) || E'\n' ||
         'The grievance assigned to you ("' || NEW.subject || '") is now closed.'),
        grievance_link('faculty', NEW.grievance_id), v_cat, v_event_key);
    END IF;
  ELSIF OLD.status IN ('Resolved', 'Rejected') AND NEW.status NOT IN ('Resolved', 'Rejected') THEN
    v_event_key := 'grievance:' || NEW.grievance_id || ':unlocked:' || NEW.updated_at;
    v_reason := NULLIF(current_setting('erp.status_note', true), '');
    CALL notify(NEW.raised_by, 'grievance',
      ('Your grievance #' || NEW.grievance_id || ' was reopened' || E'\n' ||
       'The academic office unlocked "' || NEW.subject || '"' || COALESCE(': ' || v_reason, '.')),
      v_raiser_link, v_cat, v_event_key);
    CALL notify(v_assignee, 'grievance',
      ('Grievance #' || NEW.grievance_id || ' was unlocked' || E'\n' ||
       'The academic office reopened "' || NEW.subject || '"' || COALESCE(': ' || v_reason, '.') ||
       ' Please look at it again.'),
      grievance_link('faculty', NEW.grievance_id), v_cat, v_event_key);
  END IF;
  RETURN NULL;
END $$;

-- Replies on a course grievance stay between the student and the teacher; admins hear about
-- replies only on general grievances.
CREATE OR REPLACE FUNCTION trg_grievance_notify_reply() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  g grievance%ROWTYPE;
  v_author text;
  v_author_admin boolean;
  v_text text;
  r record;
BEGIN
  SELECT * INTO g FROM grievance WHERE grievance_id = NEW.grievance_id;
  SELECT CASE WHEN role = 'admin' THEN 'The academic office' ELSE display_name END, role = 'admin'
    INTO v_author, v_author_admin FROM v_user_profile WHERE user_id = NEW.author_id;
  v_text := v_author || ' wrote: ' || CASE WHEN length(NEW.body) > 300 THEN left(NEW.body, 297) || '...' ELSE NEW.body END;
  FOR r IN
    SELECT g.raised_by AS user_id, g.raised_by_role AS role
    UNION SELECT u.user_id, u.role FROM app_user u WHERE u.faculty_id = g.assigned_to
    UNION SELECT u.user_id, u.role FROM app_user u
          WHERE u.role = 'admin' AND u.is_active AND NOT v_author_admin AND g.course_id IS NULL
  LOOP
    CONTINUE WHEN r.user_id = NEW.author_id;
    CALL notify(r.user_id, 'grievance', ('New reply on grievance #' || g.grievance_id || E'\n' || v_text),
      grievance_link(r.role, g.grievance_id), grievance_notice_category(g.category),
      'grievance:' || g.grievance_id || ':comment:' || NEW.comment_id);
  END LOOP;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------------------
-- 080's overview, plus the course a grievance is about (new columns appended at the end).
CREATE OR REPLACE VIEW v_grievance_overview AS
SELECT g.grievance_id, g.category, g.subject, g.description, g.status,
       g.raised_by, g.raised_by_role, r.login_id AS raised_by_login, r.display_name AS raised_by_name,
       r.dept_id AS raised_by_dept,
       g.assigned_to, g.assigned_at, f.faculty_code AS assigned_code,
       f.first_name || ' ' || f.last_name AS assigned_name, fu.user_id AS assigned_user_id,
       g.resolution_note, g.resolved_by, g.resolved_at, g.created_at, g.updated_at,
       (SELECT count(*) FROM grievance_comment c WHERE c.grievance_id = g.grievance_id)::int AS comment_count,
       round(extract(epoch FROM COALESCE(g.resolved_at, now()) - g.created_at)::numeric / 86400, 1) AS age_days,
       g.course_id, c.course_code, c.course_name, f.dept_id AS assigned_dept
FROM grievance g
JOIN v_user_profile r ON r.user_id = g.raised_by
LEFT JOIN faculty f ON f.faculty_id = g.assigned_to
LEFT JOIN app_user fu ON fu.faculty_id = g.assigned_to
LEFT JOIN course c ON c.course_id = g.course_id;
