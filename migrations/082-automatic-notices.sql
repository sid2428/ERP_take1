-- 082 · T8 automatic notices.
-- 1. Personal notices: a target can name one account (user_id), so the system can tell one person
--    something ("someone replied to your grievance"). They carry an optional link to act on.
-- 2. Grievance events post personal notices automatically (raised, assigned, reply, closed).
-- 3. Status alerts are computed live, not stored: attendance below the minimum and (once T6's
--    v_student_fee_status exists) fees pending. They show while true and vanish when fixed.
-- 4. Hooks for T5: post_exam_timetable_notice(...) and post_results_notice(...).
-- Depends on: 006 (v_student_attendance_by_course), 080 (grievances), 081 (notices).
-- Optional, detected at run time: v_student_fee_status (T6 contract).
SET search_path = erp, public;

-- ---------------------------------------------------------------------------------------
-- Personal targets, links and sources
ALTER TABLE notice
  ADD COLUMN link   varchar(200) CHECK (link ~ '^/[A-Za-z0-9/_?=&.-]*$'),     -- in-portal path only
  ADD COLUMN source varchar(20)  CHECK (source IN ('grievance', 'exam', 'results', 'fees', 'attendance'));

ALTER TABLE notice_target
  ADD COLUMN user_id int REFERENCES app_user ON DELETE CASCADE,
  -- a personal target names only the person
  ADD CONSTRAINT notice_target_personal_check
    CHECK (user_id IS NULL OR (role IS NULL AND dept_id IS NULL AND year_of_study IS NULL AND division_id IS NULL)),
  DROP CONSTRAINT notice_target_notice_id_role_dept_id_year_of_study_division_key,
  ADD CONSTRAINT notice_target_unique
    UNIQUE NULLS NOT DISTINCT (notice_id, role, dept_id, year_of_study, division_id, user_id);
CREATE INDEX ON notice_target (user_id) WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION notice_target_matches(t notice_target, a v_user_audience) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (t.user_id IS NULL OR t.user_id = a.user_id)
     AND (t.role IS NULL OR t.role = a.role)
     AND (t.dept_id IS NULL OR t.dept_id = a.dept_id)
     AND (t.year_of_study IS NULL OR t.year_of_study = a.year_of_study)
     AND (t.division_id IS NULL OR t.division_id = a.division_id)
$$;

-- link and source are part of the frozen notice too
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
  IF (NEW.title, NEW.body, NEW.category, NEW.is_important, NEW.posted_by, NEW.posted_at, NEW.expires_at, NEW.link, NEW.source)
     IS DISTINCT FROM
     (OLD.title, OLD.body, OLD.category, OLD.is_important, OLD.posted_by, OLD.posted_at, OLD.expires_at, OLD.link, OLD.source) THEN
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

-- v_user_notices gains the link and whether the notice was addressed to the person alone
CREATE OR REPLACE VIEW v_user_notices AS
SELECT a.user_id, n.notice_id, n.title, n.body, n.category, n.is_important, n.posted_at, n.expires_at,
       n.posted_by, COALESCE(pp.display_name, 'Academic office') AS posted_by_name, pp.role AS posted_by_role,
       r.read_at, r.read_at IS NOT NULL AS is_read,
       n.link, n.source,
       EXISTS (SELECT 1 FROM notice_target t WHERE t.notice_id = n.notice_id AND t.user_id IS NOT NULL) AS is_personal
FROM v_user_audience a
JOIN notice n ON n.withdrawn_at IS NULL AND (n.expires_at IS NULL OR n.expires_at > now())
             AND EXISTS (SELECT 1 FROM notice_target t WHERE t.notice_id = n.notice_id AND notice_target_matches(t, a))
LEFT JOIN v_user_profile pp ON pp.user_id = n.posted_by
LEFT JOIN notice_read r ON r.notice_id = n.notice_id AND r.user_id = a.user_id;

-- reach: group targets count audience groups; personal targets add the named people not already counted
CREATE OR REPLACE VIEW v_notice_reach AS
WITH audience_group AS (
  SELECT role, dept_id, year_of_study, division_id, count(*)::int AS people
  FROM v_user_audience GROUP BY role, dept_id, year_of_study, division_id
)
SELECT n.notice_id,
       ((SELECT COALESCE(sum(g.people), 0) FROM audience_group g
          WHERE EXISTS (SELECT 1 FROM notice_target t WHERE t.notice_id = n.notice_id AND t.user_id IS NULL
                          AND (t.role IS NULL OR t.role = g.role)
                          AND (t.dept_id IS NULL OR t.dept_id = g.dept_id)
                          AND (t.year_of_study IS NULL OR t.year_of_study = g.year_of_study)
                          AND (t.division_id IS NULL OR t.division_id = g.division_id)))
        + (SELECT count(*) FROM notice_target p JOIN v_user_audience a ON a.user_id = p.user_id
            WHERE p.notice_id = n.notice_id
              AND NOT EXISTS (SELECT 1 FROM notice_target t WHERE t.notice_id = n.notice_id AND t.user_id IS NULL
                                AND notice_target_matches(t, a))))::int AS recipients,
       (SELECT count(*) FROM notice_read r WHERE r.notice_id = n.notice_id)::int AS reads
FROM notice n;

-- post_notice gains link and source (old calls keep working); targets may name a user_id
DROP FUNCTION post_notice(int, text, text, notice_category, jsonb, boolean, timestamptz);
CREATE FUNCTION post_notice(p_posted_by int, p_title text, p_body text, p_category notice_category,
                            p_targets jsonb, p_is_important boolean DEFAULT false, p_expires_at timestamptz DEFAULT NULL,
                            p_link text DEFAULT NULL, p_source text DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_id int;
  t    jsonb;
BEGIN
  IF p_targets IS NULL OR jsonb_typeof(p_targets) <> 'array' OR jsonb_array_length(p_targets) = 0 THEN
    RAISE EXCEPTION 'a notice needs at least one audience target' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO notice (title, body, category, is_important, posted_by, expires_at, link, source)
  VALUES (btrim(p_title), btrim(p_body), p_category, p_is_important, p_posted_by, p_expires_at, p_link, p_source)
  RETURNING notice_id INTO v_id;
  FOR t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    INSERT INTO notice_target (notice_id, role, dept_id, year_of_study, division_id, user_id)
    VALUES (v_id, (t->>'role')::user_role, t->>'dept_id', (t->>'year_of_study')::smallint,
            (t->>'division_id')::int, (t->>'user_id')::int);
  END LOOP;
  RETURN v_id;
END $$;

-- A system notice for one person. Skips inactive accounts. Returns the notice id (or NULL).
CREATE FUNCTION notify_user(p_user_id int, p_title text, p_body text, p_category notice_category,
                            p_link text DEFAULT NULL, p_source text DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM app_user WHERE user_id = p_user_id AND is_active) THEN
    RETURN NULL;
  END IF;
  RETURN post_notice(NULL, p_title, p_body, p_category, jsonb_build_array(jsonb_build_object('user_id', p_user_id)),
                     false, now() + interval '60 days', p_link, p_source);
END $$;

-- ---------------------------------------------------------------------------------------
-- Grievance events -> personal notices
CREATE FUNCTION grievance_notice_category(c grievance_category) RETURNS notice_category
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE c WHEN 'Academic' THEN 'Academic' WHEN 'Attendance' THEN 'Academic'
                WHEN 'Fees' THEN 'Fees' WHEN 'Exam' THEN 'Exam' ELSE 'General' END::notice_category
$$;

-- where each kind of account opens a grievance
CREATE FUNCTION grievance_link(p_role user_role, p_grievance_id int) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT '/' || p_role::text || '/grievances/' || p_grievance_id $$;

CREATE FUNCTION trg_grievance_notify_new() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_name text;
  v_admin int;
BEGIN
  SELECT display_name || ' (' || login_id || ')' INTO v_name FROM v_user_profile WHERE user_id = NEW.raised_by;
  FOR v_admin IN SELECT user_id FROM app_user WHERE role = 'admin' AND is_active LOOP
    PERFORM notify_user(v_admin, 'New grievance #' || NEW.grievance_id || ': ' || NEW.subject,
      v_name || ' raised a ' || lower(NEW.category::text) || ' grievance. Assign it or reply from the grievance queue.',
      grievance_notice_category(NEW.category), grievance_link('admin', NEW.grievance_id), 'grievance');
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER notify_new AFTER INSERT ON grievance FOR EACH ROW EXECUTE FUNCTION trg_grievance_notify_new();

CREATE FUNCTION trg_grievance_notify_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_raiser_link text := grievance_link(NEW.raised_by_role, NEW.grievance_id);
  v_cat notice_category := grievance_notice_category(NEW.category);
  v_assignee int;
  v_assignee_name text;
BEGIN
  SELECT u.user_id, f.first_name || ' ' || f.last_name INTO v_assignee, v_assignee_name
  FROM faculty f LEFT JOIN app_user u ON u.faculty_id = f.faculty_id WHERE f.faculty_id = NEW.assigned_to;

  IF NEW.assigned_to IS NOT NULL AND NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    PERFORM notify_user(v_assignee, 'Grievance #' || NEW.grievance_id || ' assigned to you',
      'The academic office asked you to help with "' || NEW.subject || '". Read it and reply in the conversation.',
      v_cat, grievance_link('faculty', NEW.grievance_id), 'grievance');
    PERFORM notify_user(NEW.raised_by, 'Your grievance #' || NEW.grievance_id || ' is being handled',
      v_assignee_name || ' has been asked to help with "' || NEW.subject || '". You can talk to them in the replies.',
      v_cat, v_raiser_link, 'grievance');
  ELSIF NEW.status = 'In progress' AND OLD.status = 'Open' THEN
    PERFORM notify_user(NEW.raised_by, 'Your grievance #' || NEW.grievance_id || ' is in progress',
      'The academic office is looking into "' || NEW.subject || '".', v_cat, v_raiser_link, 'grievance');
  END IF;

  IF NEW.status IN ('Resolved', 'Rejected') AND OLD.status NOT IN ('Resolved', 'Rejected') THEN
    PERFORM notify_user(NEW.raised_by, 'Your grievance #' || NEW.grievance_id || ' was ' || lower(NEW.status::text),
      '"' || NEW.subject || '": ' || NEW.resolution_note, v_cat, v_raiser_link, 'grievance');
    IF v_assignee IS NOT NULL THEN
      PERFORM notify_user(v_assignee, 'Grievance #' || NEW.grievance_id || ' was ' || lower(NEW.status::text),
        'The grievance assigned to you ("' || NEW.subject || '") is now closed.', v_cat,
        grievance_link('faculty', NEW.grievance_id), 'grievance');
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER notify_change AFTER UPDATE ON grievance FOR EACH ROW EXECUTE FUNCTION trg_grievance_notify_change();

-- a reply tells every other participant
CREATE FUNCTION trg_grievance_notify_reply() RETURNS trigger
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
    PERFORM notify_user(r.user_id, 'New reply on grievance #' || g.grievance_id, v_text,
      grievance_notice_category(g.category), grievance_link(r.role, g.grievance_id), 'grievance');
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER notify_reply AFTER INSERT ON grievance_comment FOR EACH ROW EXECUTE FUNCTION trg_grievance_notify_reply();

-- ---------------------------------------------------------------------------------------
-- Live status alerts for one user (not stored): shown at the top of the notice board while true.
CREATE FUNCTION user_alerts(p_user_id int)
RETURNS TABLE (kind text, severity text, title text, body text, link text)
LANGUAGE plpgsql STABLE SET search_path = erp, public AS $$
DECLARE
  v_student int;
  v_n int;
  v_list text;
  fee record;
BEGIN
  SELECT student_id INTO v_student FROM app_user WHERE user_id = p_user_id AND role = 'student' AND is_active;
  IF v_student IS NULL THEN RETURN; END IF;

  -- attendance below the minimum in the current session
  SELECT count(*), string_agg(course_code || ' ' || course_name || ': ' || attendance_pct || '% (attend the next '
                              || sessions_to_recover || ' session' || CASE WHEN sessions_to_recover = 1 THEN '' ELSE 's' END
                              || ' to reach ' || min_attendance_pct || '%)', E'\n' ORDER BY attendance_pct)
    INTO v_n, v_list
  FROM v_student_attendance_by_course
  WHERE student_id = v_student AND academic_session_id = current_session_id() AND eligibility = 'Shortage';
  IF v_n > 0 THEN
    kind := 'attendance'; severity := 'high'; link := '/student';
    title := 'Attendance below the minimum in ' || v_n || ' course' || CASE WHEN v_n = 1 THEN '' ELSE 's' END;
    body := v_list;
    RETURN NEXT;
  END IF;

  -- fees pending: only once T6 provides its contract view
  IF to_regclass('erp.v_student_fee_status') IS NOT NULL THEN
    EXECUTE 'SELECT outstanding, next_due_date FROM erp.v_student_fee_status
             WHERE student_id = $1 AND NOT is_no_dues AND outstanding > 0
             ORDER BY academic_year DESC LIMIT 1' INTO fee USING v_student;
    IF fee.outstanding IS NOT NULL THEN
      kind := 'fees'; link := '/student/fee';
      IF fee.next_due_date IS NOT NULL AND fee.next_due_date < current_date THEN
        severity := 'high';
        title := 'Fees overdue: Rs ' || to_char(fee.outstanding, 'FM99,99,99,990');
        body := 'Your installment was due on ' || to_char(fee.next_due_date, 'DD Mon YYYY')
                || '. Late fees apply after 30 days. Pay or contact the accounts section.';
      ELSE
        severity := 'normal';
        title := 'Fees pending: Rs ' || to_char(fee.outstanding, 'FM99,99,99,990');
        body := CASE WHEN fee.next_due_date IS NULL THEN 'You have an outstanding fee balance.'
                     ELSE 'Next installment due on ' || to_char(fee.next_due_date, 'DD Mon YYYY') || '.' END;
      END IF;
      RETURN NEXT;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------
-- Hooks for T5 (examination): call these when the timetable or results are published.
CREATE FUNCTION post_exam_timetable_notice(p_title text, p_body text, p_dept_id varchar DEFAULT NULL,
                                           p_year smallint DEFAULT NULL, p_until timestamptz DEFAULT NULL)
RETURNS int
LANGUAGE sql SET search_path = erp, public AS $$
  SELECT post_notice(NULL, p_title, p_body, 'Exam',
           jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('role', 'student', 'dept_id', p_dept_id, 'year_of_study', p_year))),
           true, p_until, NULL, 'exam')
$$;

CREATE FUNCTION post_results_notice(p_title text, p_body text, p_dept_id varchar DEFAULT NULL, p_year smallint DEFAULT NULL)
RETURNS int
LANGUAGE sql SET search_path = erp, public AS $$
  SELECT post_notice(NULL, p_title, p_body, 'Exam',
           jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('role', 'student', 'dept_id', p_dept_id, 'year_of_study', p_year))),
           true, now() + interval '30 days', NULL, 'results')
$$;
