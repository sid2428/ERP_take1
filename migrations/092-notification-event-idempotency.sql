-- 092 · T8 event idempotency for personal notifications.
-- Existing notify signatures remain compatible; producers that have a stable event identity may
-- use the six-argument overload. The unique key is scoped to a recipient so one event can fan out.
SET search_path = erp, public;

ALTER TABLE notification ADD COLUMN event_key varchar(200);
ALTER TABLE notification ADD CONSTRAINT notification_event_key_nonblank
  CHECK (event_key IS NULL OR length(btrim(event_key)) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX notification_user_event_key_uq ON notification (user_id, event_key)
  WHERE event_key IS NOT NULL;

ALTER TABLE notice ADD COLUMN event_key varchar(200);
ALTER TABLE notice ADD CONSTRAINT notice_event_key_nonblank
  CHECK (event_key IS NULL OR length(btrim(event_key)) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX notice_event_key_uq ON notice (event_key) WHERE event_key IS NOT NULL;

-- Keep an event identity immutable along with the posted content.
CREATE OR REPLACE FUNCTION trg_notice_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.posted_by IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM app_user WHERE user_id = NEW.posted_by AND role IN ('admin', 'faculty') AND is_active) THEN
      RAISE EXCEPTION 'only the admin and faculty can post notices' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'a new notice cannot be withdrawn already' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'notice % has been withdrawn and cannot change', OLD.notice_id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.title, NEW.body, NEW.category, NEW.is_important, NEW.posted_by, NEW.posted_at, NEW.expires_at,
      NEW.link, NEW.source, NEW.event_key)
     IS DISTINCT FROM
     (OLD.title, OLD.body, OLD.category, OLD.is_important, OLD.posted_by, OLD.posted_at, OLD.expires_at,
      OLD.link, OLD.source, OLD.event_key) THEN
    RAISE EXCEPTION 'a posted notice cannot be edited; withdraw it and post a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.withdrawn_at IS NOT NULL THEN
    NEW.withdrawn_by := COALESCE(NEW.withdrawn_by, acting_user_id());
    IF NEW.withdrawn_by IS DISTINCT FROM OLD.posted_by AND NOT EXISTS (
         SELECT 1 FROM app_user WHERE user_id = NEW.withdrawn_by AND role = 'admin') THEN
      RAISE EXCEPTION 'only the poster or an admin can withdraw a notice' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Idempotent publication adapter for T5 and other event-based announcement producers.
-- The advisory transaction lock serializes concurrent retries for the same event key.
CREATE FUNCTION post_notice_once(
  p_event_key text, p_posted_by int, p_title text, p_body text, p_category notice_category,
  p_targets jsonb, p_is_important boolean DEFAULT false, p_expires_at timestamptz DEFAULT NULL,
  p_link text DEFAULT NULL, p_source text DEFAULT NULL
) RETURNS int
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_id int;
  t jsonb;
BEGIN
  IF p_event_key IS NULL OR length(btrim(p_event_key)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'notice event key must contain 1 to 200 characters' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('erp.notice:' || p_event_key, 0));
  SELECT notice_id INTO v_id FROM notice WHERE event_key = p_event_key;
  IF FOUND THEN RETURN v_id; END IF;
  IF p_targets IS NULL OR jsonb_typeof(p_targets) <> 'array' OR jsonb_array_length(p_targets) = 0 THEN
    RAISE EXCEPTION 'a notice needs at least one audience target' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO notice (title, body, category, is_important, posted_by, expires_at, link, source, event_key)
  VALUES (btrim(p_title), btrim(p_body), p_category, p_is_important, p_posted_by, p_expires_at,
          p_link, p_source, btrim(p_event_key))
  RETURNING notice_id INTO v_id;
  FOR t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    INSERT INTO notice_target (notice_id, role, dept_id, year_of_study, division_id)
    VALUES (v_id, (t->>'role')::user_role, t->>'dept_id', (t->>'year_of_study')::smallint, (t->>'division_id')::int);
  END LOOP;
  RETURN v_id;
END $$;

CREATE OR REPLACE PROCEDURE notify(
  p_user_id int, p_kind text, p_text text, p_link text, p_category notice_category
)
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  CALL notify(p_user_id, p_kind, p_text, p_link, p_category, NULL::text);
END $$;

CREATE OR REPLACE PROCEDURE notify(
  p_user_id int, p_kind text, p_text text, p_link text, p_category notice_category, p_event_key text
)
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_title text;
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM app_user WHERE user_id = p_user_id AND is_active) THEN
    RETURN;
  END IF;
  IF p_kind IS NULL OR length(btrim(p_kind)) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'notification kind must contain 1 to 20 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_text IS NULL OR length(btrim(p_text)) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'notification text must contain 1 to 5000 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_link IS NOT NULL AND p_link !~ '^/[A-Za-z0-9/_?=&.-]*$' THEN
    RAISE EXCEPTION 'notification links must be internal portal paths' USING ERRCODE = 'check_violation';
  END IF;
  IF p_event_key IS NOT NULL AND length(btrim(p_event_key)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'notification event key must contain 1 to 200 characters' USING ERRCODE = 'check_violation';
  END IF;
  v_title := CASE
    WHEN strpos(p_text, E'\n') BETWEEN 2 AND 151 THEN split_part(p_text, E'\n', 1)
    ELSE initcap(replace(p_kind, '_', ' '))
  END;
  INSERT INTO notification (user_id, kind, title, text, category, link, expires_at, event_key)
  VALUES (p_user_id, btrim(p_kind), btrim(v_title), btrim(p_text), p_category, p_link,
          now() + interval '60 days', p_event_key)
  ON CONFLICT (user_id, event_key) WHERE event_key IS NOT NULL DO NOTHING;
END $$;

CREATE OR REPLACE PROCEDURE notify(p_user_id int, p_kind text, p_text text, p_link text)
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  CALL notify(p_user_id, p_kind, p_text, p_link, 'General', NULL::text);
END $$;

-- Grievance identities are derived from authoritative row IDs and transition timestamps. Replies
-- use the immutable comment ID; assignment events use assigned_at, which the workflow trigger sets.
CREATE OR REPLACE FUNCTION trg_grievance_notify_new() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_name text;
  v_admin int;
BEGIN
  SELECT display_name || ' (' || login_id || ')' INTO v_name FROM v_user_profile WHERE user_id = NEW.raised_by;
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
  v_event_key text;
BEGIN
  SELECT u.user_id, f.first_name || ' ' || f.last_name INTO v_assignee, v_assignee_name
  FROM faculty f LEFT JOIN app_user u ON u.faculty_id = f.faculty_id WHERE f.faculty_id = NEW.assigned_to;

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
       'The academic office is looking into "' || NEW.subject || '".'), v_raiser_link, v_cat, v_event_key);
  END IF;

  IF NEW.status IN ('Resolved', 'Rejected') AND OLD.status NOT IN ('Resolved', 'Rejected') THEN
    v_event_key := 'grievance:' || NEW.grievance_id || ':' || lower(replace(NEW.status::text, ' ', '-'));
    CALL notify(NEW.raised_by, 'grievance',
      ('Your grievance #' || NEW.grievance_id || ' was ' || lower(NEW.status::text) || E'\n' ||
       '"' || NEW.subject || '": ' || NEW.resolution_note), v_raiser_link, v_cat, v_event_key);
    IF v_assignee IS NOT NULL THEN
      CALL notify(v_assignee, 'grievance',
        ('Grievance #' || NEW.grievance_id || ' was ' || lower(NEW.status::text) || E'\n' ||
         'The grievance assigned to you ("' || NEW.subject || '") is now closed.'),
        grievance_link('faculty', NEW.grievance_id), v_cat, v_event_key);
    END IF;
  END IF;
  RETURN NULL;
END $$;

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
    UNION SELECT u.user_id, u.role FROM app_user u WHERE u.role = 'admin' AND u.is_active AND NOT v_author_admin
  LOOP
    CONTINUE WHEN r.user_id = NEW.author_id;
    CALL notify(r.user_id, 'grievance', ('New reply on grievance #' || g.grievance_id || E'\n' || v_text),
      grievance_link(r.role, g.grievance_id), grievance_notice_category(g.category),
      'grievance:' || g.grievance_id || ':comment:' || NEW.comment_id);
  END LOOP;
  RETURN NULL;
END $$;

-- A drive is one publication event; the unique recipient/event index makes retries and races safe.
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
  LOOP
    CALL notify(recipient.user_id, 'placement',
      'Placement drive is open: ' || d.title || E'\n' || c_name || ' · ' || d.role_title ||
      E'\nReview details and eligibility before the application deadline.',
      drive_link, 'Placement', 'placement-drive:' || p_drive_id);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION trg_attendance_shortage_notification() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_course course%ROWTYPE;
  v_user_id int;
  v_recovery int;
  v_text text;
BEGIN
  SELECT c.* INTO v_course FROM course c WHERE c.course_id = NEW.course_id;
  IF NEW.academic_session_id IS DISTINCT FROM current_session_id()
     OR OLD.attendance_pct IS NULL
     OR OLD.attendance_pct < v_course.min_attendance_pct
     OR NEW.attendance_pct IS NULL
     OR NEW.attendance_pct >= v_course.min_attendance_pct THEN
    RETURN NEW;
  END IF;
  SELECT u.user_id INTO v_user_id
  FROM app_user u JOIN student s ON s.student_id = u.student_id
  WHERE u.role = 'student' AND u.student_id = NEW.student_id AND u.is_active AND s.status = 'Active';
  IF v_user_id IS NULL THEN RETURN NEW; END IF;
  IF v_course.min_attendance_pct < 100 THEN
    v_recovery := greatest(0, ceil((v_course.min_attendance_pct * NEW.total_sessions - 100.0 * NEW.attended)
                                   / NULLIF(100 - v_course.min_attendance_pct, 0)))::int;
  END IF;
  v_text := 'Attendance shortage: ' || v_course.course_code || ' — ' || v_course.course_name
         || E'\nYour attendance is ' || to_char(NEW.attendance_pct, 'FM990D00')
         || '%; the minimum is ' || v_course.min_attendance_pct || '%. '
         || CASE WHEN v_recovery IS NOT NULL
                 THEN 'Attend the next ' || v_recovery || ' session' || CASE WHEN v_recovery = 1 THEN '' ELSE 's' END
                   || ' to reach the minimum.'
                 ELSE 'Please contact the academic office for recovery guidance.' END;
  CALL notify(v_user_id, 'attendance_shortage', v_text, '/student', 'Academic',
    'attendance-shortage:' || NEW.student_id || ':' || NEW.course_id || ':' || NEW.academic_session_id || ':' || NEW.last_updated);
  RETURN NEW;
END $$;
