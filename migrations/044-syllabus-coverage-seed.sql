-- 044 · T3-3 Seed: tag existing attendance sessions with the unit being taught.
-- Depends on: 042 (syllabus_coverage), 043 (course_unit rows for every course).
-- For each class (teaching assignment), its Conducted sessions are taken in date order and spread over
-- the course's units in unit order, following each unit's planned_lectures. Sessions beyond the total
-- plan stay untagged. Safe to re-run: sessions that are already tagged are left alone.
SET search_path = erp, public;

INSERT INTO syllabus_coverage (session_id, unit_id)
WITH numbered AS (
  SELECT s.session_id, s.assignment_id, ta.course_id,
         row_number() OVER (PARTITION BY s.assignment_id ORDER BY s.session_date, s.session_number) AS n
  FROM attendance_session s
  JOIN teaching_assignment ta ON ta.assignment_id = s.assignment_id
  WHERE s.session_status = 'Conducted'
),
bounds AS (
  SELECT unit_id, course_id,
         sum(planned_lectures) OVER (PARTITION BY course_id ORDER BY unit_no)                  AS hi,
         sum(planned_lectures) OVER (PARTITION BY course_id ORDER BY unit_no) - planned_lectures AS lo
  FROM course_unit
)
SELECT n.session_id, b.unit_id
FROM numbered n
JOIN bounds b ON b.course_id = n.course_id AND n.n > b.lo AND n.n <= b.hi
ON CONFLICT (session_id) DO NOTHING;
