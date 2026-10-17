-- Run from the folder containing the CSVs:  mysql --local-infile=1 -u root -p erp_dbms < load_data.sql
-- (files use \n line endings; if your copy was converted to Windows line endings, change '\n' to '\r\n')
USE erp_dbms;
SET foreign_key_checks=0; SET unique_checks=0;

LOAD DATA LOCAL INFILE 'attendance_divisions.csv' INTO TABLE division FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'attendance_batches.csv' INTO TABLE batch FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'student_section_mapping.csv' INTO TABLE student_section_mapping FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'course_attendance_config.csv' INTO TABLE course_attendance_config FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'teaching_assignments.csv' INTO TABLE teaching_assignment FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n' IGNORE 1 LINES
  (assignment_id, academic_year, semester, course_id, faculty_id, division_id, @batch, session_type, weekly_sessions)
  SET batch_id = NULLIF(@batch,'');
LOAD DATA LOCAL INFILE 'attendance_sessions.csv' INTO TABLE attendance_session FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n' IGNORE 1 LINES
  (session_id, assignment_id, session_type, session_date, session_number, duration_hrs, session_status, marked_by, @marked)
  SET marked_at = NULLIF(@marked,'');

LOAD DATA LOCAL INFILE 'attendance_records_AIDS.csv'  INTO TABLE attendance_record FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'attendance_records_CIVIL.csv' INTO TABLE attendance_record FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'attendance_records_CSE.csv'   INTO TABLE attendance_record FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'attendance_records_EE.csv'    INTO TABLE attendance_record FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'attendance_records_ENTC.csv'  INTO TABLE attendance_record FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'attendance_records_IT.csv'    INTO TABLE attendance_record FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'attendance_records_MECH.csv'  INTO TABLE attendance_record FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;

LOAD DATA LOCAL INFILE 'attendance_summary.csv' INTO TABLE attendance_summary FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n' IGNORE 1 LINES;

SET foreign_key_checks=1; SET unique_checks=1;
