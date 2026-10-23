-- Shared recomputation used after examination imports and by the scheme migration.
SET search_path = erp, public;

CREATE FUNCTION refresh_exam_results() RETURNS void
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
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
END $$;

SELECT refresh_exam_results();
