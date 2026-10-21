-- Run from the folder containing the exam CSVs:  mysql --local-infile=1 -u root -p erp_dbms < load_exam_data.sql
USE erp_dbms;
SET foreign_key_checks=0; SET unique_checks=0;
LOAD DATA LOCAL INFILE 'grade_scale.csv' INTO TABLE grade_scale FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'course_exam_scheme.csv' INTO TABLE course_exam_scheme FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'exam_cycles.csv' INTO TABLE exam_cycle FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\n' IGNORE 1 LINES
  (exam_cycle_id, academic_year, semester_type, exam_type, start_date, end_date, @ro, @rc, status)
  SET registration_open = NULLIF(@ro,''), registration_close = NULLIF(@rc,'');
LOAD DATA LOCAL INFILE 'exam_schedule.csv' INTO TABLE exam_schedule FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'exam_registration.csv' INTO TABLE exam_registration FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES
  (registration_id, student_number, course_id, exam_cycle_id, attendance_percentage, registration_status, @reason, @regon)
  SET blocked_reason = NULLIF(@reason,''), registered_on = NULLIF(@regon,'');
LOAD DATA LOCAL INFILE 'hall_tickets.csv' INTO TABLE hall_ticket FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES
  (hall_ticket_id, student_number, exam_cycle_id, @htno, courses_registered, courses_blocked, status, @issued)
  SET hall_ticket_no = NULLIF(@htno,''), issued_on = NULLIF(@issued,'');
LOAD DATA LOCAL INFILE 'exam_marks.csv' INTO TABLE exam_marks FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES
  (marks_id, student_number, course_id, attempt_no, exam_cycle_id, @i, @m, @e, endsem_status, @by, @upd)
  SET internal_marks = NULLIF(@i,''), midsem_marks = NULLIF(@m,''), endsem_marks = NULLIF(@e,''),
      entered_by = NULLIF(@by,''), last_updated = NULLIF(@upd,'');
LOAD DATA LOCAL INFILE 'course_result.csv' INTO TABLE course_result FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'semester_result.csv' INTO TABLE semester_result FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
LOAD DATA LOCAL INFILE 'student_cgpa.csv' INTO TABLE student_cgpa FIELDS TERMINATED BY ',' LINES TERMINATED BY '\n' IGNORE 1 LINES;
SET foreign_key_checks=1; SET unique_checks=1;
