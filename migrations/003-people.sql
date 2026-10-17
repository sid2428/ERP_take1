-- 003 · Students (Group 1 data, cleaned) and faculty (stands in for the unavailable Group 6 data).
SET search_path = erp, public;

CREATE TYPE gender_type       AS ENUM ('Male', 'Female', 'Other');
CREATE TYPE social_category   AS ENUM ('General', 'OBC', 'SC', 'ST', 'EWS');
CREATE TYPE student_status    AS ENUM ('Active', 'Graduated', 'Inactive');
CREATE TYPE admission_type    AS ENUM ('Regular', 'Lateral Entry', 'Management');
CREATE TYPE faculty_designation AS ENUM ('Professor', 'Associate Professor', 'Assistant Professor');
CREATE TYPE employment_status AS ENUM ('Active', 'Inactive');

CREATE TABLE student (
  student_id       int          PRIMARY KEY,           -- compact surrogate key (used in attendance arrays)
  student_number   varchar(12)  NOT NULL UNIQUE,       -- institutional id, e.g. STU202600142
  first_name       varchar(50)  NOT NULL,
  middle_name      varchar(50),
  last_name        varchar(50)  NOT NULL,
  date_of_birth    date         NOT NULL,
  gender           gender_type  NOT NULL,
  blood_group      varchar(3)   CHECK (blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  email            varchar(120) NOT NULL UNIQUE,
  personal_email   varchar(120),
  mobile_number    varchar(10)  NOT NULL CHECK (mobile_number ~ '^[6-9][0-9]{9}$'),
  alternate_mobile varchar(10)  CHECK (alternate_mobile ~ '^[6-9][0-9]{9}$'),
  category         social_category NOT NULL,
  nationality      varchar(40)  NOT NULL DEFAULT 'Indian',
  status           student_status NOT NULL DEFAULT 'Active',
  admission_number varchar(15)  NOT NULL UNIQUE,
  admission_date   date         NOT NULL,
  admission_type   admission_type NOT NULL,
  admission_year   smallint     NOT NULL,
  program_id       varchar(20)  NOT NULL REFERENCES program,
  district_name    varchar(60),
  address          varchar(200),
  pincode          char(6)      CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  CHECK (extract(year FROM admission_date) = admission_year),
  CHECK (date_of_birth < admission_date - interval '15 years')
);
CREATE INDEX ON student (program_id, status);
CREATE INDEX ON student (lower(last_name), lower(first_name));

CREATE TABLE faculty (
  faculty_id      int          PRIMARY KEY,
  faculty_code    varchar(15)  NOT NULL UNIQUE,        -- e.g. FAC-CSE-014 (G2 HOD codes use this format)
  first_name      varchar(50)  NOT NULL,
  last_name       varchar(50)  NOT NULL,
  gender          gender_type  NOT NULL,
  dept_id         varchar(10)  NOT NULL REFERENCES department,
  designation     faculty_designation NOT NULL,
  qualification   varchar(20)  NOT NULL,
  date_of_joining date         NOT NULL,
  email           varchar(120) NOT NULL UNIQUE,
  mobile_number   varchar(10)  NOT NULL CHECK (mobile_number ~ '^[6-9][0-9]{9}$'),
  status          employment_status NOT NULL DEFAULT 'Active',
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX ON faculty (dept_id);

-- Closes G2's deferred HOD loop: department <-> faculty reference each other.
ALTER TABLE department
  ADD CONSTRAINT department_hod_fk FOREIGN KEY (hod_faculty_id) REFERENCES faculty
  DEFERRABLE INITIALLY DEFERRED;

-- An HOD must belong to the department they head.
CREATE FUNCTION trg_hod_in_department() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF NEW.hod_faculty_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM faculty WHERE faculty_id = NEW.hod_faculty_id AND dept_id = NEW.dept_id) THEN
    RAISE EXCEPTION 'HOD % does not belong to department %', NEW.hod_faculty_id, NEW.dept_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER hod_in_department AFTER INSERT OR UPDATE OF hod_faculty_id ON department
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_hod_in_department();

-- G2 rule "only ACTIVE faculty may be assigned": reused by offerings and teaching assignments.
CREATE FUNCTION trg_require_active_faculty() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF NEW.faculty_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM faculty WHERE faculty_id = NEW.faculty_id AND status = 'Active') THEN
    RAISE EXCEPTION 'faculty % is not active and cannot be assigned', NEW.faculty_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER touch BEFORE UPDATE ON student FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch BEFORE UPDATE ON faculty FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
