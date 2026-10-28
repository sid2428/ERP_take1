-- Expected graduation year is explicitly maintained; existing records remain unknown.
SET search_path = erp, public;

ALTER TABLE student
  ADD COLUMN expected_graduation_year smallint
  CHECK (expected_graduation_year BETWEEN 2000 AND 2100);

CREATE INDEX student_expected_graduation_year_idx
  ON student (expected_graduation_year, program_id)
  WHERE status = 'Active' AND expected_graduation_year IS NOT NULL;
