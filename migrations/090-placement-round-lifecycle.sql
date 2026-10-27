-- Keep recruitment round schedules and state transitions valid for every writer.
SET search_path = erp, public;

CREATE FUNCTION placement_round_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at <= now() THEN
      RAISE EXCEPTION 'a new recruitment round schedule must be in the future'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'Planned' AND NEW.status IN ('InProgress', 'Cancelled')) OR
        (OLD.status = 'InProgress' AND NEW.status IN ('Completed', 'Cancelled'))
    ) THEN
      RAISE EXCEPTION 'invalid recruitment round status transition: % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'InProgress' AND NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at > now() THEN
      RAISE EXCEPTION 'a recruitment round cannot start before its scheduled time'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
       AND NEW.scheduled_at IS NOT NULL AND NEW.scheduled_at <= now() THEN
      RAISE EXCEPTION 'a new recruitment round schedule must be in the future'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER placement_round_guard
  BEFORE INSERT OR UPDATE ON drive_round
  FOR EACH ROW EXECUTE FUNCTION placement_round_guard();

GRANT EXECUTE ON FUNCTION placement_round_guard() TO erp_app;

CREATE FUNCTION placement_drive_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('Draft', 'Open') THEN
      RAISE EXCEPTION 'placement drives must start as Draft or Open'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'Draft' AND NEW.status IN ('Open', 'Cancelled')) OR
        (OLD.status = 'Open' AND NEW.status IN ('Closed', 'Cancelled'))
    ) THEN
      RAISE EXCEPTION 'invalid placement drive status transition: % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER placement_drive_lifecycle_guard
  BEFORE INSERT OR UPDATE ON placement_drive
  FOR EACH ROW EXECUTE FUNCTION placement_drive_lifecycle_guard();

GRANT EXECUTE ON FUNCTION placement_drive_lifecycle_guard() TO erp_app;
