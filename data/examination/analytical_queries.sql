-- Group 3 analytical queries (portal PostgreSQL views).

-- Attendance defaulters per division in the current academic session.
SELECT division_id, division_code, academic_session_id, student_count,
       defaulter_count, defaulter_percentage
FROM erp.v_attendance_defaulters_by_division
ORDER BY defaulter_count DESC, division_code;

-- Student rank list by calculated CGPA. Equal CGPAs receive the same rank.
SELECT student_id, student_number, student_name, cgpa, cgpa_rank
FROM erp.v_student_cgpa_rank
ORDER BY cgpa_rank, student_number;
