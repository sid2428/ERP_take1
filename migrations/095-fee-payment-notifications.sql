-- 095 · T6 fee-payment success events delivered through the T8 notification contract.
-- The trigger runs in the same transaction as apply_fee_payment(), so a failed payment update
-- cannot leave a notification behind. Event identity comes from the persisted payment row.
SET search_path = erp, public;

CREATE FUNCTION trg_fee_payment_notify_success() RETURNS trigger
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  v_user_id int;
  v_title text;
BEGIN
  IF OLD.status = 'SUCCESS' OR NEW.status <> 'SUCCESS' THEN
    RETURN NEW;
  END IF;

  SELECT user_id INTO v_user_id
    FROM app_user
   WHERE student_id = NEW.student_id AND role = 'student' AND is_active;
  IF v_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_title := CASE WHEN NEW.purpose = 'FEE' THEN 'Fee payment received' ELSE 'D-Wallet top-up received' END;
  CALL notify(v_user_id, 'fees',
    v_title || E'\n' || 'Receipt ' || NEW.receipt_no || ' is ready in Fee & D-Wallet.',
    '/student/fee', 'Fees', 'fee-payment:' || NEW.payment_id || ':succeeded');
  RETURN NEW;
END $$;

CREATE TRIGGER fee_payment_notify_success
  AFTER UPDATE OF status ON fee_payment
  FOR EACH ROW EXECUTE FUNCTION trg_fee_payment_notify_success();
