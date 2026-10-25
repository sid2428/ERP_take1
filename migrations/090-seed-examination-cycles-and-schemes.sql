-- 090 · Seed standard grading scale, examination cycles, and course exam schemes.
-- Enforces: Internal continuous assessment is out of 20 marks for all courses.
-- Midsem has no practical; teachers enter internal marks out of 20 for their assigned classes.
SET search_path = erp, public;

-- 1. Standard PICT grading scale
INSERT INTO grade_scale (grade, min_percentage, max_percentage, grade_points, description)
VALUES
  ('O',  80.00, 100.00, 10, 'Outstanding'),
  ('A+', 70.00,  79.99,  9, 'Excellent'),
  ('A',  60.00,  69.99,  8, 'Very Good'),
  ('B+', 55.00,  59.99,  7, 'Good'),
  ('B',  50.00,  54.99,  6, 'Above Average'),
  ('C',  45.00,  49.99,  5, 'Average'),
  ('P',  40.00,  44.99,  4, 'Pass'),
  ('F',   0.00,  39.99,  0, 'Fail')
ON CONFLICT (grade) DO NOTHING;

-- 2. Course examination schemes:
-- Internal assessment is strictly out of 20 marks (not 50).
-- Theory (TH): 20 Internal + 20 MidSem + 60 EndSem = 100 Total
-- Practical / Lab (LAB): 20 Internal + 0 MidSem + 80 EndSem Practical/Oral = 100 Total
-- Tutorial (TUT): 20 Internal + 0 MidSem + 5 EndSem = 25 Total
INSERT INTO course_exam_scheme (course_id, internal_max, midsem_max, endsem_max, total_max, passing_percentage)
SELECT
  c.course_id,
  20 AS internal_max,
  CASE WHEN c.course_type = 'TH' THEN 20 ELSE 0 END AS midsem_max,
  CASE WHEN c.course_type = 'TH' THEN 60 WHEN c.course_type = 'LAB' THEN 80 ELSE 5 END AS endsem_max,
  CASE WHEN c.course_type = 'TUT' THEN 25 ELSE 100 END AS total_max,
  40 AS passing_percentage
FROM course c
ON CONFLICT (course_id) DO UPDATE SET
  internal_max = 20,
  midsem_max = CASE WHEN EXCLUDED.midsem_max = 20 THEN 20 ELSE 0 END,
  endsem_max = EXCLUDED.endsem_max,
  total_max = EXCLUDED.total_max,
  passing_percentage = 40;

-- 3. Examination cycles for current session 2026-ODD
INSERT INTO exam_cycle (academic_session_id, exam_type, start_date, end_date, registration_open, registration_close, status)
VALUES
  ('2026-ODD', 'MidSem', '2026-10-05', '2026-10-10', '2026-09-15', '2026-09-30', 'Registration Closed'),
  ('2026-ODD', 'EndSem', '2026-11-23', '2026-11-30', '2026-10-15', '2026-11-10', 'Upcoming')
ON CONFLICT DO NOTHING;
