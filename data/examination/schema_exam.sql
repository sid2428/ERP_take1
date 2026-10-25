-- ERP_DBMS | Group 3: Examination module (MySQL 8 / MariaDB)
-- Run AFTER the attendance schema + data (schema.sql, load_data.sql): it references course_attendance_config and attendance_summary.
-- Order: schema_exam.sql -> load_exam_data.sql -> exam_logic.sql
USE erp_dbms;

CREATE TABLE grade_scale (
  grade           VARCHAR(2) PRIMARY KEY,
  min_percentage  DECIMAL(5,2) NOT NULL,
  max_percentage  DECIMAL(5,2) NOT NULL,
  grade_points    TINYINT NOT NULL,
  description     VARCHAR(30) NOT NULL
);

CREATE TABLE course_exam_scheme (                       -- marks split differs per course (internal / midsem / endsem)
  course_id          INT PRIMARY KEY,
  credits            TINYINT NOT NULL,
  internal_max       SMALLINT NOT NULL,
  midsem_max         SMALLINT NOT NULL,                  -- 0 = no midsem for this course (labs, tutorials)
  endsem_max         SMALLINT NOT NULL,                  -- 0 = no endsem (tutorials); for labs this is the practical/oral
  total_max          SMALLINT NOT NULL,
  passing_percentage TINYINT NOT NULL DEFAULT 40,
  FOREIGN KEY (course_id) REFERENCES course_attendance_config(course_id)
);

CREATE TABLE exam_cycle (
  exam_cycle_id      INT PRIMARY KEY,
  academic_year      VARCHAR(9) NOT NULL,
  semester_type      ENUM('Odd','Even') NOT NULL,
  exam_type          ENUM('MidSem','EndSem','Supplementary') NOT NULL,
  start_date         DATE NOT NULL,
  end_date           DATE NOT NULL,
  registration_open  DATE NULL,
  registration_close DATE NULL,
  status             ENUM('Completed','Registration Closed','Upcoming') NOT NULL
);

CREATE TABLE exam_schedule (                            -- timetable for the 2026-27 MidSem and EndSem cycles
  schedule_id   INT PRIMARY KEY,
  exam_cycle_id INT NOT NULL,
  course_id     INT NOT NULL,
  exam_mode     ENUM('MidSem','EndSem Theory','Practical/Oral') NOT NULL,
  exam_date     DATE NOT NULL,
  session       ENUM('Morning','Afternoon') NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  duration_min  SMALLINT NOT NULL,
  max_marks     SMALLINT NOT NULL,
  UNIQUE (exam_cycle_id, course_id, exam_mode),
  FOREIGN KEY (exam_cycle_id) REFERENCES exam_cycle(exam_cycle_id),
  FOREIGN KEY (course_id)     REFERENCES course_attendance_config(course_id)
);

CREATE TABLE exam_registration (                        -- per student per course; Blocked when course attendance < 75%
  registration_id       INT AUTO_INCREMENT PRIMARY KEY,
  student_number        VARCHAR(20) NOT NULL,
  course_id             INT NOT NULL,
  exam_cycle_id         INT NOT NULL,
  attendance_percentage DECIMAL(5,2) NOT NULL,           -- snapshot at registration
  registration_status   ENUM('Registered','Blocked') NOT NULL,
  blocked_reason        VARCHAR(40) NULL,
  registered_on         DATETIME NULL,
  UNIQUE (student_number, course_id, exam_cycle_id),
  FOREIGN KEY (course_id)     REFERENCES course_attendance_config(course_id),
  FOREIGN KEY (exam_cycle_id) REFERENCES exam_cycle(exam_cycle_id)
);

CREATE TABLE hall_ticket (                              -- one per student per cycle; ticket no assigned only if >=1 course registered
  hall_ticket_id    INT AUTO_INCREMENT PRIMARY KEY,
  student_number    VARCHAR(20) NOT NULL,
  exam_cycle_id     INT NOT NULL,
  hall_ticket_no    VARCHAR(20) NULL UNIQUE,
  courses_registered TINYINT NOT NULL,
  courses_blocked   TINYINT NOT NULL,
  status            ENUM('Pending Issue','Issued','Withheld') NOT NULL,
  issued_on         DATE NULL,
  UNIQUE (student_number, exam_cycle_id),
  FOREIGN KEY (exam_cycle_id) REFERENCES exam_cycle(exam_cycle_id)
);

CREATE TABLE exam_marks (                               -- FACULTY SIDE: raw component marks; NULL = not yet entered / not applicable
  marks_id       INT AUTO_INCREMENT PRIMARY KEY,
  student_number VARCHAR(20) NOT NULL,
  course_id      INT NOT NULL,
  attempt_no     TINYINT NOT NULL DEFAULT 1,
  exam_cycle_id  INT NOT NULL,                           -- cycle in which the endsem component is / was taken
  internal_marks DECIMAL(5,1) NULL,
  midsem_marks   DECIMAL(5,1) NULL,
  endsem_marks   DECIMAL(5,1) NULL,
  endsem_status  ENUM('Present','Absent','Pending','NA') NOT NULL,
  entered_by     INT NULL,                               -- faculty_id
  last_updated   DATETIME NULL,
  UNIQUE (student_number, course_id, attempt_no),
  INDEX (course_id),
  FOREIGN KEY (course_id)     REFERENCES course_attendance_config(course_id),
  FOREIGN KEY (exam_cycle_id) REFERENCES exam_cycle(exam_cycle_id)
);

CREATE TABLE course_result (                            -- STUDENT SIDE: derived grade per attempt (completed semesters only)
  result_id         INT AUTO_INCREMENT PRIMARY KEY,
  student_number    VARCHAR(20) NOT NULL,
  course_id         INT NOT NULL,
  academic_year     VARCHAR(9) NOT NULL,
  semester          TINYINT NOT NULL,
  attempt_no        TINYINT NOT NULL,
  total_marks       SMALLINT NOT NULL,
  max_marks         SMALLINT NOT NULL,
  percentage        DECIMAL(5,2) NOT NULL,
  grade             VARCHAR(2) NOT NULL,
  grade_points      TINYINT NOT NULL,
  credits           TINYINT NOT NULL,
  credits_earned    TINYINT NOT NULL,
  result_status     ENUM('Pass','Fail') NOT NULL,
  is_final_attempt  TINYINT(1) NOT NULL,                 -- 1 = latest attempt, the one counted in SGPA/CGPA
  UNIQUE (student_number, course_id, attempt_no),
  INDEX (student_number, is_final_attempt),
  FOREIGN KEY (course_id) REFERENCES course_attendance_config(course_id),
  FOREIGN KEY (grade)     REFERENCES grade_scale(grade)
);

CREATE TABLE semester_result (                          -- SGPA = sum(credits*grade_points)/sum(credits) over final attempts
  semester_result_id  INT AUTO_INCREMENT PRIMARY KEY,
  student_number      VARCHAR(20) NOT NULL,
  academic_year       VARCHAR(9) NOT NULL,
  semester            TINYINT NOT NULL,
  credits_registered  SMALLINT NOT NULL,
  credits_earned      SMALLINT NOT NULL,
  sgpa                DECIMAL(4,2) NOT NULL,
  backlogs            TINYINT NOT NULL,
  result_status       ENUM('Pass','ATKT') NOT NULL,
  UNIQUE (student_number, semester)
);

CREATE TABLE student_cgpa (                             -- expected output of calculate_cgpa(); Year-1 students have no row (no completed semester)
  student_number      VARCHAR(20) PRIMARY KEY,
  semesters_completed TINYINT NOT NULL,
  credits_attempted   SMALLINT NOT NULL,
  credits_earned      SMALLINT NOT NULL,
  cgpa                DECIMAL(4,2) NOT NULL,
  backlog_count       TINYINT NOT NULL
);

-- ---------- Views ----------
CREATE VIEW v_student_result_sheet AS
SELECT r.student_number, r.academic_year, r.semester, c.course_id, c.course_name, r.credits,
       r.total_marks, r.max_marks, r.percentage, r.grade, r.grade_points, r.result_status, r.attempt_no
FROM course_result r JOIN course_attendance_config c ON c.course_id = r.course_id
WHERE r.is_final_attempt = 1;

CREATE VIEW v_student_exam_timetable AS                 -- only courses the student is Registered for
SELECT g.student_number, c.course_name, s.exam_mode, s.exam_date, s.session, s.start_time, s.end_time, s.exam_cycle_id
FROM exam_registration g
JOIN exam_schedule s ON s.exam_cycle_id = g.exam_cycle_id AND s.course_id = g.course_id AND s.exam_mode <> 'MidSem'
JOIN course_attendance_config c ON c.course_id = g.course_id
WHERE g.registration_status = 'Registered';

CREATE VIEW v_faculty_marks_entry AS                    -- current-term marks rows a faculty member is allowed to fill
SELECT ta.faculty_id, m.marks_id, m.student_number, m.course_id, m.internal_marks, m.midsem_marks, m.endsem_marks, m.endsem_status
FROM exam_marks m
JOIN exam_cycle ec ON ec.exam_cycle_id = m.exam_cycle_id AND ec.status <> 'Completed'
JOIN student_section_mapping ssm ON ssm.student_number = m.student_number
JOIN teaching_assignment ta ON ta.course_id = m.course_id AND ta.division_id = ssm.division_id
     AND (ta.batch_id IS NULL OR ta.batch_id = ssm.batch_id) AND ta.academic_year = ec.academic_year;

-- ---------- Cross-group foreign keys: enable once Group 1/6 tables exist ----------
-- ALTER TABLE exam_registration ADD FOREIGN KEY (student_number) REFERENCES students(student_number);
-- ALTER TABLE hall_ticket       ADD FOREIGN KEY (student_number) REFERENCES students(student_number);
-- ALTER TABLE exam_marks        ADD FOREIGN KEY (student_number) REFERENCES students(student_number);
-- ALTER TABLE exam_marks        ADD FOREIGN KEY (entered_by)     REFERENCES faculty(faculty_id);
-- ALTER TABLE course_result     ADD FOREIGN KEY (student_number) REFERENCES students(student_number);
-- ALTER TABLE semester_result   ADD FOREIGN KEY (student_number) REFERENCES students(student_number);
-- ALTER TABLE student_cgpa      ADD FOREIGN KEY (student_number) REFERENCES students(student_number);
