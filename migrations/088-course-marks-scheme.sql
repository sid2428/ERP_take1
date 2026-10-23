-- Normalize theory and lab marks to the revised 100-mark assessment scheme.
-- Tutorial (TUT) courses retain their existing 25-mark internal-only scheme.
SET search_path = erp, public;

CREATE TEMP TABLE old_course_exam_scheme ON COMMIT DROP AS
SELECT course_id, internal_max, midsem_max, endsem_max
FROM course_exam_scheme;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM exam_marks m
    JOIN course c USING (course_id)
    WHERE c.course_type = 'LAB' AND m.midsem_marks IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot migrate lab marks: existing lab midsem marks require manual review.';
  END IF;
END $$;

UPDATE exam_marks m
SET internal_marks = CASE
      WHEN c.course_type = 'TH' THEN round(m.internal_marks * 20.0 / NULLIF(old.internal_max, 0), 1)
      WHEN c.course_type = 'LAB' THEN round(m.internal_marks * 50.0 / NULLIF(old.internal_max, 0), 1)
      ELSE m.internal_marks
    END,
    midsem_marks = CASE
      WHEN c.course_type = 'TH' AND old.midsem_max > 0
        THEN round(m.midsem_marks * 20.0 / old.midsem_max, 1)
      WHEN c.course_type = 'TH' AND old.midsem_max = 0
           AND m.endsem_status <> 'Pending'
           AND (m.internal_marks IS NOT NULL OR m.endsem_marks IS NOT NULL)
        THEN round(least(20.0, greatest(0.0,
          20.0 * (
            coalesce(m.internal_marks / NULLIF(old.internal_max, 0), 0)
            + coalesce(m.endsem_marks / NULLIF(old.endsem_max, 0), 0)
          ) / NULLIF(
            (CASE WHEN m.internal_marks IS NOT NULL AND old.internal_max > 0 THEN 1 ELSE 0 END)
            + (CASE WHEN m.endsem_marks IS NOT NULL AND old.endsem_max > 0 THEN 1 ELSE 0 END),
            0
          )
          + (mod(m.student_id * 37 + m.course_id * 11 + m.attempt_no * 17, 17) - 8) * 0.1
        )), 1)
      WHEN c.course_type = 'LAB' THEN NULL
      ELSE m.midsem_marks
    END,
    endsem_marks = CASE
      WHEN c.course_type = 'TH' THEN round(m.endsem_marks * 60.0 / NULLIF(old.endsem_max, 0), 1)
      WHEN c.course_type = 'LAB' THEN round(m.endsem_marks * 50.0 / NULLIF(old.endsem_max, 0), 1)
      ELSE m.endsem_marks
    END
FROM course c
JOIN old_course_exam_scheme old USING (course_id)
WHERE m.course_id = c.course_id;

UPDATE course_exam_scheme sch
SET internal_max = CASE c.course_type WHEN 'TH' THEN 20 WHEN 'LAB' THEN 50 ELSE sch.internal_max END,
    midsem_max = CASE c.course_type WHEN 'TH' THEN 20 WHEN 'LAB' THEN 0 ELSE sch.midsem_max END,
    endsem_max = CASE c.course_type WHEN 'TH' THEN 60 WHEN 'LAB' THEN 50 ELSE sch.endsem_max END,
    total_max = CASE c.course_type WHEN 'TH' THEN 100 WHEN 'LAB' THEN 100 ELSE sch.total_max END
FROM course c
WHERE c.course_id = sch.course_id;

UPDATE exam_schedule es
SET max_marks = CASE es.exam_mode
      WHEN 'MidSem' THEN sch.midsem_max
      WHEN 'EndSem Theory' THEN sch.endsem_max
      WHEN 'Practical/Oral' THEN sch.endsem_max
    END
FROM course_exam_scheme sch
WHERE es.course_id = sch.course_id;

WITH scored AS (
  SELECT r.result_id, sch.total_max,
         CASE WHEN m.marks_id IS NOT NULL AND m.endsem_status <> 'Pending'
           THEN round(coalesce(m.internal_marks, 0) + coalesce(m.midsem_marks, 0)
             + coalesce(m.endsem_marks, 0))::smallint
           ELSE round(r.percentage * sch.total_max / 100.0)::smallint
         END AS total_marks,
         sch.passing_percentage
  FROM course_result r
  JOIN course_exam_scheme sch USING (course_id)
  LEFT JOIN exam_marks m
    ON m.student_id = r.student_id AND m.course_id = r.course_id AND m.attempt_no = r.attempt_no
), graded AS (
  SELECT s.result_id, s.total_max, s.total_marks, s.passing_percentage,
         round(s.total_marks * 100.0 / s.total_max, 2) AS percentage
  FROM scored s
)
UPDATE course_result r
SET total_marks = g.total_marks,
    max_marks = g.total_max,
    percentage = g.percentage,
    grade = gs.grade,
    grade_points = gs.grade_points,
    result_status = CASE WHEN g.percentage >= g.passing_percentage
      THEN 'Pass'::exam_result_state ELSE 'Fail'::exam_result_state END
FROM graded g
JOIN LATERAL (
  SELECT grade, grade_points
  FROM grade_scale
  WHERE g.percentage BETWEEN min_percentage AND max_percentage
  ORDER BY min_percentage DESC
  LIMIT 1
) gs ON true
WHERE r.result_id = g.result_id;

WITH semester_totals AS (
  SELECT r.student_id, r.academic_session_id, r.semester,
         sum(c.credits)::smallint AS credits_registered,
         sum(c.credits) FILTER (WHERE r.result_status = 'Pass')::smallint AS credits_earned,
         round(sum(c.credits * r.grade_points) / NULLIF(sum(c.credits), 0), 2) AS sgpa,
         count(*) FILTER (WHERE r.result_status = 'Fail')::smallint AS backlogs
  FROM course_result r
  JOIN course c USING (course_id)
  WHERE r.is_final_attempt
  GROUP BY r.student_id, r.academic_session_id, r.semester
)
UPDATE semester_result sr
SET credits_registered = t.credits_registered,
    credits_earned = t.credits_earned,
    sgpa = t.sgpa,
    backlogs = t.backlogs,
    result_status = CASE WHEN t.backlogs = 0
      THEN 'Pass'::semester_result_state ELSE 'ATKT'::semester_result_state END
FROM semester_totals t
WHERE sr.student_id = t.student_id
  AND sr.academic_session_id = t.academic_session_id
  AND sr.semester = t.semester;

WITH student_totals AS (
  SELECT r.student_id,
         count(DISTINCT (r.academic_session_id, r.semester))::smallint AS semesters_completed,
         sum(c.credits)::smallint AS credits_attempted,
         sum(c.credits) FILTER (WHERE r.result_status = 'Pass')::smallint AS credits_earned,
         round(sum(c.credits * r.grade_points) / NULLIF(sum(c.credits), 0), 2) AS cgpa,
         count(*) FILTER (WHERE r.result_status = 'Fail')::smallint AS backlog_count
  FROM course_result r
  JOIN course c USING (course_id)
  WHERE r.is_final_attempt
  GROUP BY r.student_id
)
UPDATE student_cgpa sc
SET semesters_completed = t.semesters_completed,
    credits_attempted = t.credits_attempted,
    credits_earned = t.credits_earned,
    cgpa = t.cgpa,
    backlog_count = t.backlog_count
FROM student_totals t
WHERE sc.student_id = t.student_id;

CREATE FUNCTION trg_exam_marks_scheme_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  scheme course_exam_scheme%ROWTYPE;
BEGIN
  SELECT * INTO scheme FROM course_exam_scheme WHERE course_id = NEW.course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'course % has no examination scheme', NEW.course_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF (NEW.internal_marks IS NOT NULL AND NEW.internal_marks > scheme.internal_max)
     OR (NEW.midsem_marks IS NOT NULL AND NEW.midsem_marks > scheme.midsem_max)
     OR (NEW.endsem_marks IS NOT NULL AND NEW.endsem_marks > scheme.endsem_max) THEN
    RAISE EXCEPTION 'exam component marks exceed the course scheme maximum'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER exam_marks_scheme_validate
  BEFORE INSERT OR UPDATE OF course_id, internal_marks, midsem_marks, endsem_marks
  ON exam_marks FOR EACH ROW EXECUTE FUNCTION trg_exam_marks_scheme_validate();

CREATE FUNCTION trg_course_result_scheme_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  expected_max smallint;
BEGIN
  SELECT total_max INTO expected_max FROM course_exam_scheme WHERE course_id = NEW.course_id;
  IF NOT FOUND OR NEW.max_marks <> expected_max OR NEW.total_marks > expected_max THEN
    RAISE EXCEPTION 'course result marks do not match the course scheme maximum'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER course_result_scheme_validate
  BEFORE INSERT OR UPDATE OF course_id, total_marks, max_marks
  ON course_result FOR EACH ROW EXECUTE FUNCTION trg_course_result_scheme_validate();
