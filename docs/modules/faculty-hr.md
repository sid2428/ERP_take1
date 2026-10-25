# Faculty & HR: Leave Management and Payroll (T2 / G6)

The Faculty & HR module provides comprehensive leave management, automated payroll processing with Loss of Pay (LOP) integration, salary structure revisions, and faculty workload insights.

Migrations: `migrations/030-faculty-hr-leave-payroll.sql`, `migrations/031-seed-faculty-leave-payroll.sql` ·
Routes: `src/routes/api-routes.ts`, `src/routes/faculty-routes.ts` ·
Queries: `src/queries/faculty-queries.ts` ·
Tests: `tests/db/faculty-hr.test.ts`, `tests/app/faculty-api.test.ts` ·
Frontend views: `views/faculty/dashboard.ejs`, `public/js/faculty-dashboard.js`

---

## 1. Workflows

### 1.1 Leave Management Workflow
```
             faculty applies               admin approves
  [Form] ──────────────────────▶ PENDING ─────────────────▶ APPROVED (balance deducted)
                                    │                           │
                                    │ admin rejects             │ faculty cancels
                                    ▼                           ▼
                                 REJECTED                    CANCELLED (balance restored)
```

- Leave quotas: **Casual Leave (CL: 12 days)**, **Earned Leave (EL: 15 days)**, **Medical Leave (ML: 10 days)**, and **Loss of Pay (LOP: 0 days, unpaid)**.
- Quotas are tracked per calendar year via transaction ledgers and balance functions.
- GiST exclusion constraint (`btree_gist`) strictly blocks any faculty member from having overlapping non-cancelled leave requests.
- When an admin approves leave, an automated trigger credits `faculty_leave_transaction` and decrements remaining days.
- When an approved leave is cancelled, an automated trigger credits back the days to the faculty ledger.

### 1.2 Payroll Workflow
```
  [generate_monthly_payroll]              admin reviews/approves          finance disburses
 ─────────────────────────────▶ DRAFT ───────────────────────────▶ APPROVED ──────────────────▶ PAID (frozen)
```

- Salary structures: Defined per faculty member with basic pay, allowances, deductions, and a computed leave deduction per day.
- Payroll generation scans approved **Loss of Pay (LOP)** leave requests falling within the calendar month and calculates deductions dynamically:
  $$\text{Leave Deduction} = \text{LOP Days} \times \text{Leave Deduction Per Day}$$
  $$\text{Net Salary} = \text{Basic Salary} + \text{Allowances} - \text{Deductions} - \text{Leave Deductions}$$
- Itemized breakdown rows are created in `payroll_item` for every pay run.
- Immutable state guards: Approved and Paid payroll runs cannot be deleted or modified; item rows cannot be tampered with once finalized.

---

## 2. Tables

| Table | Primary Key | Description & Foreign Keys |
|---|---|---|
| `faculty_leave_type` | `leave_type_id` | Definitions of leave kinds (`leave_name`, `annual_quota`, `is_paid`, `is_active`) |
| `faculty_leave_request` | `leave_request_id` | Leave applications (`faculty_id` → `faculty`, `leave_type_id` → `faculty_leave_type`, `from_date`, `to_date`, `days_requested`, `status`, `approved_by` → `app_user`) |
| `faculty_leave_transaction` | `transaction_id` | Ledger entries tracking credit and debit of leave days per year |
| `salary_structure` | `salary_structure_id` | Effective faculty compensation (`faculty_id` → `faculty`, `basic_salary`, `allowances`, `deductions`, `leave_deduction_per_day`, `effective_from`, `effective_to`) |
| `payroll` | `payroll_id` | Monthly payroll runs (`faculty_id` → `faculty`, `payroll_month`, `payroll_year`, `net_salary`, `status`, `approved_by` → `app_user`) |
| `payroll_item` | `payroll_item_id` | Line-item breakdown per payslip (`payroll_id` → `payroll`, `component_name`, `component_type`, `amount`) |

---

## 3. Rules and Where They Are Enforced

| Rule | Enforcement Point |
|---|---|
| No overlapping leave requests for the same faculty | `EXCLUDE USING gist (faculty_id WITH =, daterange(from_date, to_date, '[]') WITH &&)` WHERE `(status <> 'CANCELLED')` |
| End date must be on or after start date | `CHECK (to_date >= from_date)` on `faculty_leave_request` |
| New leave requests must start in `PENDING` status | Trigger `trg_faculty_leave_request_before_insert` on `faculty_leave_request` |
| Status transitions restricted to `PENDING -> APPROVED / REJECTED` and `APPROVED -> CANCELLED` | Trigger `trg_faculty_leave_request_before_update` on `faculty_leave_request` |
| Leave balance is automatically deducted on approval | Trigger `trg_faculty_leave_request_after_update` inserts debit row into `faculty_leave_transaction` |
| Leave balance is automatically restored on cancellation | Trigger `trg_faculty_leave_request_after_update` inserts credit row into `faculty_leave_transaction` |
| Non-overlapping salary structure effective date ranges | `EXCLUDE USING gist (faculty_id WITH =, daterange(effective_from, COALESCE(effective_to, '9999-12-31'::date), '[)') WITH &&)` |
| Payroll status moves only `DRAFT -> APPROVED -> PAID` | Trigger `trg_payroll_before_update` on `payroll` |
| Approved or Paid payroll figures are immutable | Trigger `trg_payroll_before_update` blocks column alterations once status is not `DRAFT` |
| Line-item payslip components cannot be modified once approved | Trigger `trg_payroll_item_guard` on `payroll_item` |

---

## 4. Contract Views and Functions

### 4.1 Inter-Team Contract Views
- `v_faculty_leave_balance`: Exposed for attendance (T4) and admin reports (T0):
  ```sql
  SELECT faculty_id, leave_type, remaining FROM v_faculty_leave_balance WHERE faculty_id = 74;
  ```
- `v_faculty_leave_balance_current_year`: Detailed breakdown of opening balances, quotas, and remaining days for the current year.

### 4.2 Stored Functions & Procedures
- **Calculate Leave Balance**:
  ```sql
  SELECT get_faculty_leave_balance(74, 1); -- faculty_id, leave_type_id
  ```
- **Approve Leave Request**:
  ```sql
  CALL approve_faculty_leave(15, 1); -- leave_request_id, admin_user_id
  ```
- **Reject Leave Request**:
  ```sql
  CALL reject_faculty_leave(15, 1, 'Insufficient team coverage');
  ```
- **Cancel Leave Request**:
  ```sql
  CALL cancel_faculty_leave(15, 'Personal plans changed');
  ```
- **Generate Monthly Payroll**:
  ```sql
  SELECT * FROM generate_monthly_payroll(11, 2026); -- month, year
  ```
- **Update Payroll Status**:
  ```sql
  CALL update_payroll_status(202611001, 'APPROVED', 1);
  ```

---

## 5. API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/faculty/:id/dashboard` | Aggregated dashboard data including leave balances, pending count, and latest payslip |
| `GET` | `/api/leave/types` | List of active leave types and annual quotas |
| `GET` | `/api/faculty/:id/leave/balance` | Current faculty leave balances |
| `GET` | `/api/faculty/:id/leave/requests` | History of faculty leave requests with approval status |
| `POST` | `/api/faculty/:id/leave/apply` | Apply for new leave |
| `POST` | `/api/faculty/:id/leave/requests/:reqId/cancel` | Cancel an approved or pending leave request |
| `GET` | `/api/faculty/:id/payroll/payslips` | List of monthly payslips |
| `GET` | `/api/faculty/:id/payroll/payslips/:payrollId` | Detailed payslip statement with line-item breakdown |
| `GET` | `/api/faculty/:id/payroll/salary-structure` | Faculty salary structure details |
| `GET` | `/api/admin/hr/leave/requests` | Admin approval queue for leave requests |
| `POST` | `/api/admin/hr/leave/requests/:reqId/approve` | Admin approve leave |
| `POST` | `/api/admin/hr/leave/requests/:reqId/reject` | Admin reject leave |
| `POST` | `/api/admin/hr/payroll/generate` | Generate monthly payroll run |
| `POST` | `/api/admin/hr/payroll/:payrollId/status` | Advance payroll status (`APPROVED` or `PAID`) |

---

## 6. 3-Minute Demo Script

1. **Sign in as Faculty**:
   - URL: `http://localhost:3100/login`
   - Account: Login as faculty member (e.g. `FAC-CSE-074` / password as configured).
   - Dashboard: Notice the Leave Balance widgets (CL: 10/12, EL: 15/15, ML: 8/10) and Latest Payslip status.
2. **Apply for Leave**:
   - Navigate to the **Leave** tab on the sidebar.
   - Choose leave type (e.g., Casual Leave), select start and end dates, provide reason: *"Paper presentation at conference"*, and click **Submit Request**.
   - Notice the status is `PENDING`.
3. **Admin Review & Approval**:
   - In another browser tab or session, call or use admin endpoint:
     `POST /api/admin/hr/leave/requests/:reqId/approve`
   - Refresh the faculty leave tab: The request status transitions to `APPROVED` and Casual Leave remaining balance decrements by the requested days.
4. **View Salary Structure & Payslips**:
   - Navigate to the **Payroll & Payslips** tab.
   - View active salary structure card (Basic: ₹90,000, Allowances: ₹54,000, Deductions: ₹11,000).
   - Click on the latest payslip (August 2026 / September 2026): A modal statement opens showing the itemized earnings, deductions, LOP calculations, and net salary disbursement status (`PAID`).
