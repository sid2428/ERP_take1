-- Group 3 PBL requirements: calculate_cgpa UDF + trigger blocking exam registration below 75% attendance.
-- Run AFTER load_exam_data.sql (so the trigger does not fire on the bulk load).
USE erp_dbms;
DELIMITER //

CREATE FUNCTION calculate_cgpa(p_student_number VARCHAR(20)) RETURNS DECIMAL(4,2)
READS SQL DATA
BEGIN
  DECLARE v_cgpa DECIMAL(12,6);
  SELECT SUM(credits * grade_points) / SUM(credits) INTO v_cgpa
  FROM course_result
  WHERE student_number = p_student_number AND is_final_attempt = 1;
  RETURN ROUND(v_cgpa, 2);              -- NULL if the student has no completed semester
END//

CREATE TRIGGER trg_block_exam_registration_ins BEFORE INSERT ON exam_registration
FOR EACH ROW
BEGIN
  DECLARE v_att DECIMAL(5,2);
  IF NEW.registration_status = 'Registered' THEN
    SELECT s.attendance_percentage INTO v_att
    FROM attendance_summary s JOIN exam_cycle c ON c.exam_cycle_id = NEW.exam_cycle_id AND c.academic_year = s.academic_year
    WHERE s.student_number = NEW.student_number AND s.course_id = NEW.course_id;
    IF v_att IS NULL OR v_att < 75 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exam registration blocked: attendance below 75%';
    END IF;
  END IF;
END//

CREATE TRIGGER trg_block_exam_registration_upd BEFORE UPDATE ON exam_registration
FOR EACH ROW
BEGIN
  DECLARE v_att DECIMAL(5,2);
  IF NEW.registration_status = 'Registered' AND OLD.registration_status <> 'Registered' THEN
    SELECT s.attendance_percentage INTO v_att
    FROM attendance_summary s JOIN exam_cycle c ON c.exam_cycle_id = NEW.exam_cycle_id AND c.academic_year = s.academic_year
    WHERE s.student_number = NEW.student_number AND s.course_id = NEW.course_id;
    IF v_att IS NULL OR v_att < 75 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exam registration blocked: attendance below 75%';
    END IF;
  END IF;
END//
DELIMITER ;
