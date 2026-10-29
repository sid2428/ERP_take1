-- 100 · Faculty-Specific Payroll Generation & Filtering
-- Overloads generate_monthly_payroll to accept an optional p_faculty_id parameter.
-- If p_faculty_id is provided, only that faculty member's payroll is computed/updated.
SET search_path = erp, public;

CREATE OR REPLACE FUNCTION generate_monthly_payroll(p_month INT, p_year INT, p_faculty_id INT)
RETURNS TABLE (result_month INT, result_year INT, rows_generated INT,
               rows_skipped_locked INT, rows_skipped_no_structure INT)
LANGUAGE plpgsql SET search_path = erp, public AS $$
DECLARE
    v_faculty_id INT;
    v_ss_id      INT;
    v_basic      NUMERIC(12,2);
    v_allow      NUMERIC(12,2);
    v_ded        NUMERIC(12,2);
    v_per_day    NUMERIC(10,2);
    v_unpaid     NUMERIC;
    v_leave_ded  NUMERIC(12,2);
    v_net        NUMERIC(12,2);
    v_payroll_id BIGINT;
    v_existing   payroll_status;
    v_first      DATE;
    v_last       DATE;
    v_generated  INT := 0;
    v_locked     INT := 0;
    v_nostruct   INT := 0;
BEGIN
    IF p_month IS NULL OR p_month < 1 OR p_month > 12 THEN
        RAISE EXCEPTION 'Payroll month must be between 1 and 12';
    END IF;
    IF p_year IS NULL OR p_year < 2000 THEN
        RAISE EXCEPTION 'Invalid payroll year';
    END IF;

    v_first := make_date(p_year, p_month, 1);
    v_last  := (v_first + INTERVAL '1 month' - INTERVAL '1 day')::DATE;

    FOR v_faculty_id IN
        SELECT f.faculty_id FROM faculty f
         WHERE f.status = 'Active' AND f.date_of_joining <= v_last
           AND (p_faculty_id IS NULL OR f.faculty_id = p_faculty_id)
         ORDER BY f.faculty_id
    LOOP
        SELECT s.salary_structure_id, s.basic_salary, s.allowances, s.deductions, s.leave_deduction_per_day
          INTO v_ss_id, v_basic, v_allow, v_ded, v_per_day
          FROM salary_structure s
         WHERE s.faculty_id = v_faculty_id
           AND s.effective_from <= v_last
           AND (s.effective_to IS NULL OR s.effective_to >= v_first)
         ORDER BY s.effective_from DESC, s.salary_structure_id DESC
         LIMIT 1;

        IF v_ss_id IS NULL THEN
            v_nostruct := v_nostruct + 1;
            CONTINUE;
        END IF;

        SELECT p.status INTO v_existing FROM payroll p
         WHERE p.faculty_id = v_faculty_id AND p.payroll_month = p_month AND p.payroll_year = p_year;
        IF v_existing IS NOT NULL AND v_existing <> 'DRAFT' THEN
            v_locked := v_locked + 1;
            CONTINUE;
        END IF;

        SELECT COALESCE(SUM(ROUND(
                   lr.days_requested
                   * ((LEAST(lr.to_date, v_last) - GREATEST(lr.from_date, v_first)) + 1)
                   / ((lr.to_date - lr.from_date) + 1), 2)), 0)
          INTO v_unpaid
          FROM faculty_leave_request lr
          JOIN faculty_leave_type lt ON lt.leave_type_id = lr.leave_type_id
         WHERE lr.faculty_id = v_faculty_id
           AND lr.status = 'APPROVED'
           AND lt.is_paid = FALSE
           AND lr.from_date <= v_last
           AND lr.to_date   >= v_first;

        v_leave_ded := LEAST(ROUND(v_unpaid * v_per_day, 2), v_basic + v_allow - v_ded);
        v_net       := v_basic + v_allow - v_ded - v_leave_ded;

        IF v_existing = 'DRAFT' THEN
            UPDATE payroll p
               SET basic_salary = v_basic, allowances = v_allow, deductions = v_ded,
                   leave_deductions = v_leave_ded, net_salary = v_net,
                   salary_structure_id = v_ss_id, generated_at = now()
             WHERE p.faculty_id = v_faculty_id AND p.payroll_month = p_month AND p.payroll_year = p_year
            RETURNING p.payroll_id INTO v_payroll_id;
            DELETE FROM payroll_item WHERE payroll_id = v_payroll_id;
        ELSE
            INSERT INTO payroll
                (faculty_id, payroll_month, payroll_year, basic_salary, allowances, deductions,
                 leave_deductions, net_salary, status, salary_structure_id)
            VALUES
                (v_faculty_id, p_month, p_year, v_basic, v_allow, v_ded,
                 v_leave_ded, v_net, 'DRAFT', v_ss_id)
            RETURNING payroll_id INTO v_payroll_id;
        END IF;

        INSERT INTO payroll_item (payroll_id, component_name, component_type, amount)
        VALUES (v_payroll_id, 'Basic Salary', 'BASIC', v_basic);
        IF v_allow > 0 THEN
            INSERT INTO payroll_item (payroll_id, component_name, component_type, amount)
            VALUES (v_payroll_id, 'Allowances', 'ALLOWANCE', v_allow);
        END IF;
        IF v_ded > 0 THEN
            INSERT INTO payroll_item (payroll_id, component_name, component_type, amount)
            VALUES (v_payroll_id, 'Deductions', 'DEDUCTION', v_ded);
        END IF;
        IF v_leave_ded > 0 THEN
            INSERT INTO payroll_item (payroll_id, component_name, component_type, amount)
            VALUES (v_payroll_id, 'Leave Deduction (LOP)', 'DEDUCTION', v_leave_ded);
        END IF;

        v_generated := v_generated + 1;
    END LOOP;

    RETURN QUERY SELECT p_month, p_year, v_generated, v_locked, v_nostruct;
END $$;

CREATE OR REPLACE FUNCTION generate_monthly_payroll(p_month INT, p_year INT)
RETURNS TABLE (result_month INT, result_year INT, rows_generated INT,
               rows_skipped_locked INT, rows_skipped_no_structure INT)
LANGUAGE sql SET search_path = erp, public AS $$
    SELECT * FROM generate_monthly_payroll(p_month, p_year, NULL::INT);
$$;
