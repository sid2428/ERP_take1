-- Extra sessions can share a date with the regular scheduled session.
SET search_path = erp, public;

ALTER TABLE attendance_session
  ADD COLUMN is_extra boolean NOT NULL DEFAULT false,
  ADD COLUMN reason text,
  ADD COLUMN created_by int REFERENCES faculty;

ALTER TABLE attendance_session
  DROP CONSTRAINT attendance_session_assignment_id_session_date_key,
  ADD CONSTRAINT attendance_session_extra_metadata_check CHECK (
    (is_extra AND reason IS NOT NULL AND length(btrim(reason)) > 0 AND created_by IS NOT NULL)
    OR (NOT is_extra AND reason IS NULL AND created_by IS NULL)
  );

CREATE UNIQUE INDEX attendance_session_one_regular_per_date
  ON attendance_session (assignment_id, session_date)
  WHERE is_extra = false;
