-- 092 · Record how each fee payment was made (UPI, Card, Net Banking...).
-- Why a new file: 042 had already been applied to the shared database without this column, and an
-- applied migration must not be edited. Safe to run on a database that already has the column
-- (a fresh database built from the newer 042 gets the same result).
-- Depends on: 042.
SET search_path = erp, public;

ALTER TABLE fee_payment ADD COLUMN IF NOT EXISTS method varchar(20);

-- apply_fee_payment gains an optional third argument (the method). Drop the old two-argument
-- version so there is only one function; calls with two arguments still work through the default.
DROP FUNCTION IF EXISTS apply_fee_payment(varchar, varchar);

CREATE OR REPLACE FUNCTION apply_fee_payment(p_gateway_order_id varchar, p_gateway_payment_id varchar,
                                             p_method varchar DEFAULT NULL)
RETURNS fee_payment
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
  pay     fee_payment%ROWTYPE;
  rec     fee_record%ROWTYPE;
  applied bigint;
  excess  bigint;
BEGIN
  SELECT * INTO pay FROM fee_payment WHERE gateway_order_id = p_gateway_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown payment order %', p_gateway_order_id USING ERRCODE = 'no_data_found';
  END IF;
  IF pay.status = 'SUCCESS' THEN
    RETURN pay;                                         -- already applied
  END IF;

  UPDATE fee_payment
     SET status = 'SUCCESS', gateway_payment_id = p_gateway_payment_id, method = COALESCE(p_method, method),
         receipt_no = next_receipt_no(), paid_at = now(), failure_reason = NULL
   WHERE payment_id = pay.payment_id
  RETURNING * INTO pay;

  IF pay.purpose = 'FEE' THEN
    SELECT * INTO rec FROM fee_record WHERE fee_record_id = pay.fee_record_id FOR UPDATE;
    applied := LEAST(pay.amount_paise, rec.outstanding_paise);
    excess  := pay.amount_paise - applied;
    UPDATE fee_record SET online_paid_paise = online_paid_paise + applied
     WHERE fee_record_id = rec.fee_record_id;
    IF excess > 0 THEN
      PERFORM wallet_credit(pay.student_id, excess, 'EXCESS_CREDIT', pay.payment_id,
                            'Excess fee payment credited to D-Wallet');
    END IF;
  ELSE
    PERFORM wallet_credit(pay.student_id, pay.amount_paise, 'TOPUP', pay.payment_id, 'D-Wallet top-up');
  END IF;
  RETURN pay;
END $$;

-- The receipt view now includes the method (a view cannot gain a column in the middle, so recreate it).
DROP VIEW IF EXISTS v_fee_receipt;
CREATE VIEW v_fee_receipt AS
SELECT p.payment_id, p.receipt_no, p.paid_at, p.purpose, p.amount_paise,
       p.gateway, p.gateway_order_id, p.gateway_payment_id, p.method,
       s.student_id, s.student_number, s.first_name || ' ' || s.last_name AS student_name,
       pr.program_id, pr.program_name, d.dept_id, d.dept_name,
       p.fee_record_id, f.academic_year,
       f.tuition_paise, f.development_paise, f.examination_paise, f.other_paise, f.late_fee_paise,
       f.total_due_paise, f.paid_paise, f.outstanding_paise, f.fee_status
FROM fee_payment p
JOIN student s    ON s.student_id = p.student_id
JOIN program pr   ON pr.program_id = s.program_id
JOIN department d ON d.dept_id = pr.dept_id
LEFT JOIN fee_record f ON f.fee_record_id = p.fee_record_id
WHERE p.status = 'SUCCESS';

-- Same rights as before for the new function and view
GRANT EXECUTE ON FUNCTION apply_fee_payment(varchar, varchar, varchar) TO erp_app;
GRANT SELECT ON v_fee_receipt TO erp_app;
