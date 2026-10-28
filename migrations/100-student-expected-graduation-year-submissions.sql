-- Student-entered expected years remain pending until an administrator verifies them.
SET search_path = erp, public;

ALTER TABLE student
  ADD COLUMN submitted_expected_graduation_year smallint
  CHECK (submitted_expected_graduation_year BETWEEN 2000 AND 2100);

CREATE INDEX student_submitted_expected_graduation_year_idx
  ON student (submitted_expected_graduation_year, program_id)
  WHERE submitted_expected_graduation_year IS NOT NULL;
