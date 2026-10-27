-- 031 · T2 Faculty & HR: Seed leave history and payroll runs (Jul–Sep 2026 PAID, Oct 2026 DRAFT).
-- Depends on: 003 (faculty), 007 (app_user), 030 (faculty_leave_request, payroll, generate_monthly_payroll).

SET search_path = erp, public;

-- 1. Seed sample faculty leave requests across Jul–Oct 2026 as PENDING
INSERT INTO faculty_leave_request (faculty_id, leave_type_id, from_date, to_date, days_requested, reason, status)
SELECT
    f.faculty_id,
    1, -- Casual Leave
    '2026-07-15'::DATE,
    '2026-07-16'::DATE,
    2,
    'Family event in hometown',
    'PENDING'::leave_status
FROM faculty f
WHERE f.faculty_id IN (74, 1, 2)
ON CONFLICT DO NOTHING;

INSERT INTO faculty_leave_request (faculty_id, leave_type_id, from_date, to_date, days_requested, reason, status)
SELECT
    f.faculty_id,
    3, -- Medical Leave
    '2026-08-10'::DATE,
    '2026-08-11'::DATE,
    2,
    'Viral fever and medical rest',
    'PENDING'::leave_status
FROM faculty f
WHERE f.faculty_id IN (74, 3)
ON CONFLICT DO NOTHING;

INSERT INTO faculty_leave_request (faculty_id, leave_type_id, from_date, to_date, days_requested, reason, status)
SELECT
    f.faculty_id,
    1, -- Casual Leave
    '2026-10-28'::DATE,
    '2026-10-29'::DATE,
    2,
    'Attending national research conference',
    'PENDING'::leave_status
FROM faculty f
WHERE f.faculty_id IN (74, 4)
ON CONFLICT DO NOTHING;

-- Approve the historical ones via the approval procedure
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT leave_request_id
        FROM faculty_leave_request
        WHERE reason IN ('Family event in hometown', 'Viral fever and medical rest')
          AND status = 'PENDING'
    LOOP
        CALL approve_faculty_leave(r.leave_request_id, 1);
    END LOOP;
END $$;

-- 2. Generate monthly payrolls for Jul, Aug, Sep, Oct 2026
SELECT * FROM generate_monthly_payroll(7, 2026);
SELECT * FROM generate_monthly_payroll(8, 2026);
SELECT * FROM generate_monthly_payroll(9, 2026);
SELECT * FROM generate_monthly_payroll(10, 2026);

-- 3. Transition Jul, Aug, Sep to APPROVED and then PAID
-- July 2026
UPDATE payroll
   SET status = 'APPROVED'::payroll_status,
       approved_by = 1,
       approved_at = '2026-07-28 10:00:00+00'
 WHERE payroll_year = 2026 AND payroll_month = 7 AND status = 'DRAFT';

UPDATE payroll
   SET status = 'PAID'::payroll_status,
       paid_at = '2026-07-31 17:00:00+00'
 WHERE payroll_year = 2026 AND payroll_month = 7 AND status = 'APPROVED';

-- August 2026
UPDATE payroll
   SET status = 'APPROVED'::payroll_status,
       approved_by = 1,
       approved_at = '2026-08-28 10:00:00+00'
 WHERE payroll_year = 2026 AND payroll_month = 8 AND status = 'DRAFT';

UPDATE payroll
   SET status = 'PAID'::payroll_status,
       paid_at = '2026-08-31 17:00:00+00'
 WHERE payroll_year = 2026 AND payroll_month = 8 AND status = 'APPROVED';

-- September 2026
UPDATE payroll
   SET status = 'APPROVED'::payroll_status,
       approved_by = 1,
       approved_at = '2026-09-28 10:00:00+00'
 WHERE payroll_year = 2026 AND payroll_month = 9 AND status = 'DRAFT';

UPDATE payroll
   SET status = 'PAID'::payroll_status,
       paid_at = '2026-09-30 17:00:00+00'
 WHERE payroll_year = 2026 AND payroll_month = 9 AND status = 'APPROVED';
