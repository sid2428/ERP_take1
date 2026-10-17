-- ERP_DBMS | Group 3: Attendance module  (MySQL 8 / MariaDB)
-- Load order: schema.sql -> load_data.sql
-- Cross-group tables (students, faculty, courses, departments) belong to Groups 1/2/6;
-- the foreign keys to them are at the bottom, commented out until those tables exist.

CREATE DATABASE IF NOT EXISTS erp_dbms;
USE erp_dbms;

CREATE TABLE division (
  division_id    INT PRIMARY KEY,
  division_code  VARCHAR(20) NOT NULL UNIQUE,          -- e.g. CSE-Y2-A
  department_id  VARCHAR(10) NOT NULL,
  year_of_study  TINYINT NOT NULL,
  semester       TINYINT NOT NULL,
  academic_year  VARCHAR(9) NOT NULL,
  strength       SMALLINT NOT NULL
);

CREATE TABLE batch (                                    -- lab batches inside a division
  batch_id     INT PRIMARY KEY,
  batch_code   VARCHAR(25) NOT NULL UNIQUE,            -- e.g. CSE-Y2-A-B1
  division_id  INT NOT NULL,
  strength     SMALLINT NOT NULL,
  FOREIGN KEY (division_id) REFERENCES division(division_id)
);

CREATE TABLE student_section_mapping (                  -- department > division > batch per student
  student_number VARCHAR(20) PRIMARY KEY,
  department_id  VARCHAR(10) NOT NULL,
  year_of_study  TINYINT NOT NULL,
  semester       TINYINT NOT NULL,
  academic_year  VARCHAR(9) NOT NULL,
  division_id    INT NOT NULL,
  batch_id       INT NOT NULL,
  roll_no        SMALLINT NOT NULL,
  UNIQUE (division_id, roll_no),
  FOREIGN KEY (division_id) REFERENCES division(division_id),
  FOREIGN KEY (batch_id)    REFERENCES batch(batch_id)
);

CREATE TABLE course_attendance_config (                 -- theory/lab categorisation + schedule rules per course
  course_id            INT PRIMARY KEY,
  course_name          VARCHAR(100) NOT NULL,
  department_id        VARCHAR(10) NOT NULL,
  course_type          ENUM('Theory','Lab') NOT NULL,
  is_tutorial          TINYINT(1) NOT NULL DEFAULT 0,   -- tutorials are treated as Theory lectures
  year_of_study        TINYINT NOT NULL,
  semester             TINYINT NOT NULL,
  sessions_per_week    TINYINT NOT NULL,
  session_duration_hrs DECIMAL(3,1) NOT NULL,
  min_attendance_pct   TINYINT NOT NULL DEFAULT 75
);

CREATE TABLE teaching_assignment (                      -- who may mark attendance for what (theory: batch_id NULL)
  assignment_id  INT AUTO_INCREMENT PRIMARY KEY,
  academic_year  VARCHAR(9) NOT NULL,
  semester       TINYINT NOT NULL,
  course_id      INT NOT NULL,
  faculty_id     INT NOT NULL,
  division_id    INT NOT NULL,
  batch_id       INT NULL,
  session_type   ENUM('Lecture','Lab') NOT NULL,
  weekly_sessions TINYINT NOT NULL,
  INDEX (faculty_id),
  FOREIGN KEY (course_id)   REFERENCES course_attendance_config(course_id),
  FOREIGN KEY (division_id) REFERENCES division(division_id),
  FOREIGN KEY (batch_id)    REFERENCES batch(batch_id)
);

CREATE TABLE attendance_session (                       -- FACULTY SIDE: one row per lecture/lab held on a date
  session_id     INT AUTO_INCREMENT PRIMARY KEY,
  assignment_id  INT NOT NULL,
  session_type   ENUM('Lecture','Lab') NOT NULL,
  session_date   DATE NOT NULL,
  session_number SMALLINT NOT NULL,
  duration_hrs   DECIMAL(3,1) NOT NULL,
  session_status ENUM('Conducted','Cancelled') NOT NULL DEFAULT 'Conducted',
  marked_by      INT NOT NULL,                          -- faculty_id
  marked_at      DATETIME NULL,
  UNIQUE (assignment_id, session_date),
  INDEX (session_date),
  FOREIGN KEY (assignment_id) REFERENCES teaching_assignment(assignment_id)
);

CREATE TABLE attendance_record (                        -- one row per student per conducted session
  attendance_id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id     INT NOT NULL,
  student_number VARCHAR(20) NOT NULL,
  status         ENUM('P','A') NOT NULL,
  UNIQUE (session_id, student_number),
  INDEX (student_number),
  FOREIGN KEY (session_id) REFERENCES attendance_session(session_id)
);

CREATE TABLE attendance_summary (                       -- STUDENT SIDE: per student per course totals
  summary_id            INT AUTO_INCREMENT PRIMARY KEY,
  student_number        VARCHAR(20) NOT NULL,
  course_id             INT NOT NULL,
  academic_year         VARCHAR(9) NOT NULL,
  semester              TINYINT NOT NULL,
  course_type           ENUM('Theory','Lab') NOT NULL,
  total_lectures        SMALLINT NOT NULL,
  lectures_attended     SMALLINT NOT NULL,
  lectures_absent       SMALLINT NOT NULL,
  attendance_percentage DECIMAL(5,2) NOT NULL,
  eligibility_status    ENUM('Eligible','Shortage') NOT NULL,  -- Eligible = percentage >= 75
  last_updated          DATETIME NULL,
  UNIQUE (student_number, course_id, academic_year),
  FOREIGN KEY (course_id) REFERENCES course_attendance_config(course_id)
);

-- ---------- Views ----------
CREATE VIEW v_student_attendance_by_course AS
SELECT s.student_number, c.course_id, c.course_name, s.course_type,
       s.total_lectures, s.lectures_attended, s.lectures_absent,
       s.attendance_percentage, s.eligibility_status, s.last_updated
FROM attendance_summary s JOIN course_attendance_config c ON c.course_id = s.course_id;

CREATE VIEW v_student_attendance_overall AS
SELECT student_number,
       SUM(total_lectures)    AS total_lectures,
       SUM(lectures_attended) AS lectures_attended,
       ROUND(100*SUM(lectures_attended)/SUM(total_lectures),2) AS overall_percentage,
       IF(100*SUM(lectures_attended)/SUM(total_lectures) >= 75,'Eligible','Shortage') AS overall_status
FROM attendance_summary GROUP BY student_number;

CREATE VIEW v_faculty_session_sheet AS                  -- faculty dashboard: sessions with present/absent counts
SELECT ta.faculty_id, s.session_id, s.session_date, s.session_type, s.session_status,
       ta.course_id, d.division_code, b.batch_code,
       SUM(r.status='P') AS present_count, SUM(r.status='A') AS absent_count
FROM attendance_session s
JOIN teaching_assignment ta ON ta.assignment_id = s.assignment_id
JOIN division d ON d.division_id = ta.division_id
LEFT JOIN batch b ON b.batch_id = ta.batch_id
LEFT JOIN attendance_record r ON r.session_id = s.session_id
GROUP BY ta.faculty_id, s.session_id, s.session_date, s.session_type, s.session_status,
         ta.course_id, d.division_code, b.batch_code;

-- ---------- Re-sync student summary after faculty add/edit attendance ----------
-- (run as-is, or scope it with a WHERE on student/course; later wrap into a trigger/procedure)
-- INSERT INTO attendance_summary (student_number, course_id, academic_year, semester, course_type,
--        total_lectures, lectures_attended, lectures_absent, attendance_percentage, eligibility_status, last_updated)
-- SELECT r.student_number, ta.course_id, ta.academic_year, ta.semester, c.course_type,
--        COUNT(*), SUM(r.status='P'), SUM(r.status='A'),
--        ROUND(100*SUM(r.status='P')/COUNT(*),2),
--        IF(100*SUM(r.status='P')/COUNT(*) >= 75,'Eligible','Shortage'), MAX(s.marked_at)
-- FROM attendance_record r
-- JOIN attendance_session s ON s.session_id = r.session_id
-- JOIN teaching_assignment ta ON ta.assignment_id = s.assignment_id
-- JOIN course_attendance_config c ON c.course_id = ta.course_id
-- GROUP BY r.student_number, ta.course_id, ta.academic_year, ta.semester, c.course_type
-- ON DUPLICATE KEY UPDATE total_lectures=VALUES(total_lectures), lectures_attended=VALUES(lectures_attended),
--   lectures_absent=VALUES(lectures_absent), attendance_percentage=VALUES(attendance_percentage),
--   eligibility_status=VALUES(eligibility_status), last_updated=VALUES(last_updated);

-- ---------- Cross-group foreign keys: enable once Group 1/2/6/7 tables exist ----------
-- ALTER TABLE student_section_mapping ADD FOREIGN KEY (student_number) REFERENCES students(student_number);
-- ALTER TABLE attendance_record       ADD FOREIGN KEY (student_number) REFERENCES students(student_number);
-- ALTER TABLE attendance_summary      ADD FOREIGN KEY (student_number) REFERENCES students(student_number);
-- ALTER TABLE teaching_assignment     ADD FOREIGN KEY (faculty_id)     REFERENCES faculty(faculty_id);
-- ALTER TABLE attendance_session      ADD FOREIGN KEY (marked_by)      REFERENCES faculty(faculty_id);
-- ALTER TABLE course_attendance_config ADD FOREIGN KEY (course_id)     REFERENCES courses(course_id);  -- (replace with a FK from Group 2 to this if you prefer)
-- ALTER TABLE division                ADD FOREIGN KEY (department_id)  REFERENCES departments(department_id);
