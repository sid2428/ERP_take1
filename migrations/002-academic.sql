-- 002 · Academic structure (Group 2), translated from MySQL to PostgreSQL.
-- G2 guardrails reproduced here:
--   * exactly one current academic session  -> partial unique index + set_current_session()
--   * prerequisite cycles rejected           -> trigger with a recursive CTE
--   * electives must name their basket       -> CHECK pairing category <-> elective_group
SET search_path = erp, public;

CREATE TYPE degree_level     AS ENUM ('UG', 'PG');
CREATE TYPE course_type      AS ENUM ('TH', 'LAB', 'TUT');
CREATE TYPE term_type        AS ENUM ('ODD', 'EVEN');
CREATE TYPE course_category  AS ENUM ('CORE', 'PROF_ELECTIVE', 'OPEN_ELECTIVE');

CREATE TABLE department (
  dept_id          varchar(10)  PRIMARY KEY,
  dept_name        varchar(100) NOT NULL UNIQUE,
  hod_faculty_id   int,                          -- FK added in 003 (faculty is created after departments)
  office_room      varchar(20),
  contact_email    varchar(100),
  established_year smallint CHECK (established_year BETWEEN 1900 AND 2100),
  is_active        boolean      NOT NULL DEFAULT true,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE program (
  program_id        varchar(20)  PRIMARY KEY,
  dept_id           varchar(10)  NOT NULL REFERENCES department,
  program_name      varchar(100) NOT NULL,
  degree_level      degree_level NOT NULL,
  duration_years    smallint     NOT NULL CHECK (duration_years BETWEEN 1 AND 6),
  total_semesters   smallint     NOT NULL,
  total_credits_req numeric(5,1) NOT NULL CHECK (total_credits_req > 0),
  intake_capacity   smallint     NOT NULL CHECK (intake_capacity > 0),
  is_active         boolean      NOT NULL DEFAULT true,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CHECK (total_semesters = 2 * duration_years)
);

CREATE TABLE course (
  course_id          int          PRIMARY KEY,            -- G2 ids kept (other datasets reference them)
  course_code        varchar(12)  NOT NULL UNIQUE,
  course_name        varchar(120) NOT NULL,
  dept_id            varchar(10)  NOT NULL REFERENCES department,   -- home (owning) department
  credits            numeric(3,1) NOT NULL CHECK (credits > 0),
  course_type        course_type  NOT NULL,
  lecture_hrs        smallint     NOT NULL CHECK (lecture_hrs   >= 0),
  tutorial_hrs       smallint     NOT NULL CHECK (tutorial_hrs  >= 0),
  practical_hrs      smallint     NOT NULL CHECK (practical_hrs >= 0),
  syllabus_version   varchar(10)  NOT NULL,
  min_attendance_pct smallint     NOT NULL DEFAULT 75 CHECK (min_attendance_pct BETWEEN 0 AND 100),
  is_active          boolean      NOT NULL DEFAULT true,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  CHECK (lecture_hrs + tutorial_hrs + practical_hrs > 0)
);
CREATE INDEX ON course (dept_id);

CREATE TABLE course_prerequisite (
  course_id        int        NOT NULL REFERENCES course,
  prereq_course_id int        NOT NULL REFERENCES course,
  min_grade        varchar(2) NOT NULL DEFAULT 'P',
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, prereq_course_id),
  CHECK (course_id <> prereq_course_id)
);
CREATE INDEX ON course_prerequisite (prereq_course_id);

CREATE TABLE academic_session (
  session_id    varchar(10) PRIMARY KEY,                  -- e.g. 2026-ODD
  session_name  varchar(40) NOT NULL,
  academic_year varchar(7)  NOT NULL CHECK (academic_year ~ '^\d{4}-\d{2}$'),
  term_type     term_type   NOT NULL,
  start_date    date        NOT NULL,
  end_date      date        NOT NULL,
  is_current    boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (academic_year, term_type),
  CHECK (end_date > start_date)
);
-- At most one row may have is_current = true: enforced declaratively, not by convention.
CREATE UNIQUE INDEX academic_session_one_current ON academic_session (is_current) WHERE is_current;

CREATE TABLE program_curriculum (
  program_id      varchar(20)     NOT NULL REFERENCES program,
  course_id       int             NOT NULL REFERENCES course,
  semester_no     smallint        NOT NULL CHECK (semester_no BETWEEN 1 AND 12),
  course_category course_category NOT NULL,
  elective_group  varchar(4),
  created_at      timestamptz     NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, course_id),
  CHECK ((course_category = 'CORE') = (elective_group IS NULL))
);
CREATE INDEX ON program_curriculum (course_id);
CREATE INDEX ON program_curriculum (program_id, semester_no);

-- ---------------------------------------------------------------------------------------
-- Prerequisite cycles: walk the chain upwards from the new prerequisite; if it reaches the
-- course itself, the edge would close a loop.
CREATE FUNCTION trg_prerequisite_no_cycle() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE chain(cid) AS (
      SELECT NEW.prereq_course_id
      UNION
      SELECT p.prereq_course_id FROM course_prerequisite p JOIN chain c ON p.course_id = c.cid
    )
    SELECT 1 FROM chain WHERE cid = NEW.course_id
  ) THEN
    RAISE EXCEPTION 'prerequisite cycle detected: course % cannot require %', NEW.course_id, NEW.prereq_course_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prerequisite_no_cycle BEFORE INSERT OR UPDATE ON course_prerequisite
  FOR EACH ROW EXECUTE FUNCTION trg_prerequisite_no_cycle();

-- A curriculum placement cannot sit beyond the program's last semester.
CREATE FUNCTION trg_curriculum_semester_in_range() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF NEW.semester_no > (SELECT total_semesters FROM program WHERE program_id = NEW.program_id) THEN
    RAISE EXCEPTION 'semester % is beyond the last semester of program %', NEW.semester_no, NEW.program_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER curriculum_semester_in_range BEFORE INSERT OR UPDATE ON program_curriculum
  FOR EACH ROW EXECUTE FUNCTION trg_curriculum_semester_in_range();

-- Switch the current session atomically (the partial unique index forbids two at once).
CREATE PROCEDURE set_current_session(p_session_id varchar)
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM academic_session WHERE session_id = p_session_id) THEN
    RAISE EXCEPTION 'unknown academic session %', p_session_id USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE academic_session SET is_current = false WHERE is_current AND session_id <> p_session_id;
  UPDATE academic_session SET is_current = true  WHERE session_id = p_session_id;
END $$;

CREATE FUNCTION current_session_id() RETURNS varchar
LANGUAGE sql STABLE AS $$ SELECT session_id FROM erp.academic_session WHERE is_current $$;

CREATE TRIGGER touch BEFORE UPDATE ON department       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON program          FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON course           FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON academic_session FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Readable views (G2's V_* exports, now live).
CREATE VIEW v_course_catalog AS
SELECT c.course_id, c.course_code, c.course_name, c.dept_id, d.dept_name, c.credits, c.course_type,
       c.lecture_hrs || '-' || c.tutorial_hrs || '-' || c.practical_hrs AS l_t_p,
       c.syllabus_version, c.is_active,
       (SELECT count(*) FROM course_prerequisite p WHERE p.course_id = c.course_id)        AS prereqs_needed,
       (SELECT count(*) FROM course_prerequisite p WHERE p.prereq_course_id = c.course_id) AS unlocks,
       (SELECT count(*) FROM program_curriculum pc WHERE pc.course_id = c.course_id)       AS in_programs
FROM course c JOIN department d USING (dept_id);

CREATE VIEW v_curriculum AS
SELECT pc.program_id, p.program_name, p.dept_id, pc.semester_no, pc.course_category, pc.elective_group,
       c.course_id, c.course_code, c.course_name, c.course_type, c.credits, c.dept_id AS course_home_dept,
       CASE WHEN c.dept_id = p.dept_id THEN 'own' ELSE 'shared/cross-dept' END AS placement_kind
FROM program_curriculum pc JOIN program p USING (program_id) JOIN course c USING (course_id);
