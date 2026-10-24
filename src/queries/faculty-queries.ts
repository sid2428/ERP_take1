import { query, queryOne } from '../db.js';

export interface FacultyProfile {
  faculty_id: number; faculty_code: string; first_name: string; last_name: string; gender: string; dept_id: string;
  dept_name: string; designation: string; qualification: string; date_of_joining: string; email: string;
  mobile_number: string; status: string; is_hod: boolean;
}

export function getFacultyProfile(facultyId: number): Promise<FacultyProfile | undefined> {
  return queryOne<FacultyProfile>(`
    SELECT f.*, d.dept_name, d.hod_faculty_id = f.faculty_id AS is_hod
    FROM faculty f JOIN department d USING (dept_id) WHERE f.faculty_id = $1`, [facultyId]);
}

export interface ClassRow {
  assignment_id: number; session_type: string; course_id: number; course_code: string; course_name: string;
  course_type: string; min_attendance_pct: number; class_label: string; batch_code: string | null; weekly_sessions: number;
  students: number; sessions_held: number; avg_pct: number | null; below_min: number; last_session: string | null;
}

/** A faculty member's teaching assignments this term, with attendance statistics. */
export function getFacultyClasses(facultyId: number): Promise<ClassRow[]> {
  return query<ClassRow>(`
    SELECT ta.assignment_id, ta.session_type, ta.weekly_sessions, c.course_id, c.course_code, c.course_name,
           c.course_type, c.min_attendance_pct,
           COALESCE(d.division_code, c.course_code || ' honors ' || o.section_name) AS class_label, b.batch_code,
           (SELECT count(*) FROM v_assignment_roster r WHERE r.assignment_id = ta.assignment_id)::int AS students,
           st.sessions_held, st.last_session, sm.avg_pct, sm.below_min
    FROM teaching_assignment ta
    JOIN course c USING (course_id)
    LEFT JOIN division d ON d.division_id = ta.division_id
    LEFT JOIN batch b ON b.batch_id = ta.batch_id
    LEFT JOIN course_offering o ON o.offering_id = ta.offering_id
    LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE session_status = 'Conducted')::int AS sessions_held,
                              max(session_date) FILTER (WHERE session_status = 'Conducted') AS last_session
                       FROM attendance_session s WHERE s.assignment_id = ta.assignment_id) st ON true
    LEFT JOIN LATERAL (SELECT round(avg(attendance_pct), 1) AS avg_pct,
                              count(*) FILTER (WHERE attendance_pct < c.min_attendance_pct)::int AS below_min
                       FROM attendance_summary a WHERE a.assignment_id = ta.assignment_id) sm ON true
    WHERE ta.faculty_id = $1 AND ta.academic_session_id = current_session_id()
    ORDER BY c.course_code, class_label, b.batch_code`, [facultyId]);
}

export function getAssignment(assignmentId: number, facultyId: number): Promise<ClassRow | undefined> {
  return getFacultyClasses(facultyId).then((rows) => rows.find((r) => r.assignment_id === assignmentId));
}

export interface RosterRow {
  student_id: number; student_number: string; name: string; roll_no: number | null; batch_code: string | null;
  total_sessions: number | null; attended: number | null; attendance_pct: number | null; sessions_to_recover: number | null;
}

export function getRoster(assignmentId: number): Promise<RosterRow[]> {
  return query<RosterRow>(`
    SELECT s.student_id, s.student_number, s.first_name || ' ' || s.last_name AS name, ss.roll_no, b.batch_code,
           a.total_sessions, a.attended, a.attendance_pct, a.sessions_to_recover
    FROM v_assignment_roster r
    JOIN teaching_assignment ta USING (assignment_id)
    JOIN student s ON s.student_id = r.student_id
    LEFT JOIN student_section ss ON ss.student_id = s.student_id AND ss.academic_session_id = ta.academic_session_id
    LEFT JOIN batch b ON b.batch_id = ss.batch_id
    LEFT JOIN v_student_attendance_by_course a
           ON a.student_id = s.student_id AND a.course_id = ta.course_id AND a.academic_session_id = ta.academic_session_id
    WHERE r.assignment_id = $1
    ORDER BY ss.division_id, ss.roll_no, s.student_number`, [assignmentId]);
}

/** True if the student sits in any of this faculty member's classes this term. */
export async function teachesStudent(facultyId: number, studentId: number): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(`
    SELECT EXISTS (SELECT 1 FROM teaching_assignment ta JOIN v_assignment_roster r USING (assignment_id)
                   WHERE ta.faculty_id = $1 AND r.student_id = $2 AND ta.academic_session_id = current_session_id()) AS ok`,
    [facultyId, studentId]);
  return row?.ok ?? false;
}

/* =====================================================================
   T2 · FACULTY HR, LEAVE MANAGEMENT & PAYROLL QUERIES
   ================================================================== */

export interface FacultyLeaveType {
  leave_type_id: number;
  leave_name: string;
  annual_quota: number;
  is_paid: boolean;
  is_active: boolean;
}

export interface FacultyLeaveBalance {
  leave_type_id: number;
  leave_name: string;
  annual_quota: number;
  balance_days: number;
  is_paid: boolean;
}

export interface FacultyLeaveRequest {
  leave_request_id: number;
  faculty_id: number;
  faculty_name?: string;
  faculty_code?: string;
  leave_type_id: number;
  leave_name: string;
  from_date: string;
  to_date: string;
  days_requested: number;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  approved_by: number | null;
  approver_name: string | null;
  approved_at: string | null;
  decision_remarks: string | null;
  created_at: string;
}

export interface FacultySalaryStructure {
  salary_structure_id: number;
  faculty_id: number;
  basic_salary: number;
  allowances: number;
  deductions: number;
  leave_deduction_per_day: number;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
}

export interface FacultyPayrollItem {
  payroll_item_id: number;
  payroll_id: number;
  component_name: string;
  component_type: 'BASIC' | 'ALLOWANCE' | 'DEDUCTION';
  amount: number;
}

export interface FacultyPayslip {
  payroll_id: number;
  faculty_id: number;
  faculty_name?: string;
  faculty_code?: string;
  payroll_month: number;
  payroll_year: number;
  period_text: string;
  basic_salary: number;
  allowances: number;
  deductions: number;
  leave_deductions: number;
  net_salary: number;
  status: 'DRAFT' | 'APPROVED' | 'PAID';
  generated_at: string;
  approved_by: number | null;
  approved_at: string | null;
  paid_at: string | null;
  items?: FacultyPayrollItem[];
}

export function getFacultyLeaveTypes(): Promise<FacultyLeaveType[]> {
  return query<FacultyLeaveType>('SELECT * FROM faculty_leave_type WHERE is_active ORDER BY leave_type_id');
}

export function getFacultyLeaveBalances(facultyId: number): Promise<FacultyLeaveBalance[]> {
  return query<FacultyLeaveBalance>(`
    SELECT lt.leave_type_id, lt.leave_name, lt.annual_quota,
           COALESCE(get_faculty_leave_balance(f.faculty_id, lt.leave_type_id), lt.annual_quota) AS balance_days,
           lt.is_paid
    FROM faculty f
    CROSS JOIN faculty_leave_type lt
    WHERE f.faculty_id = $1 AND lt.is_active
    ORDER BY lt.leave_type_id`, [facultyId]);
}

export function getFacultyLeaveRequests(facultyId: number): Promise<FacultyLeaveRequest[]> {
  return query<FacultyLeaveRequest>(`
    SELECT lr.leave_request_id, lr.faculty_id, lr.leave_type_id, lt.leave_name,
           lr.from_date, lr.to_date, lr.days_requested, lr.reason, lr.status,
           lr.approved_by, u.display_name AS approver_name, lr.approved_at,
           lr.decision_remarks, lr.created_at
    FROM faculty_leave_request lr
    JOIN faculty_leave_type lt USING (leave_type_id)
    LEFT JOIN v_user_profile u ON u.user_id = lr.approved_by
    WHERE lr.faculty_id = $1
    ORDER BY lr.created_at DESC`, [facultyId]);
}

export async function submitLeaveRequest(
  facultyId: number, leaveTypeId: number, fromDate: string, toDate: string, daysRequested: number, reason: string,
): Promise<number> {
  const row = await queryOne<{ leave_request_id: number }>(`
    INSERT INTO faculty_leave_request (faculty_id, leave_type_id, from_date, to_date, days_requested, reason, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
    RETURNING leave_request_id`, [facultyId, leaveTypeId, fromDate, toDate, daysRequested, reason]);
  return row!.leave_request_id;
}

export async function cancelLeaveRequest(leaveRequestId: number, remarks = 'Cancelled by faculty'): Promise<void> {
  await query('CALL cancel_faculty_leave($1, $2)', [leaveRequestId, remarks]);
}

export function getFacultySalaryStructure(facultyId: number): Promise<FacultySalaryStructure[]> {
  return query<FacultySalaryStructure>(`
    SELECT salary_structure_id, faculty_id, basic_salary, allowances, deductions,
           leave_deduction_per_day, effective_from, effective_to,
           (effective_to IS NULL OR effective_to >= CURRENT_DATE) AS is_active
    FROM salary_structure
    WHERE faculty_id = $1
    ORDER BY effective_from DESC`, [facultyId]);
}

export function getFacultyPayslips(facultyId: number): Promise<FacultyPayslip[]> {
  return query<FacultyPayslip>(`
    SELECT p.payroll_id, p.faculty_id, p.payroll_month, p.payroll_year,
           to_char(make_date(p.payroll_year, p.payroll_month, 1), 'FMMonth YYYY') AS period_text,
           p.basic_salary, p.allowances, p.deductions, p.leave_deductions, p.net_salary,
           p.status, p.generated_at, p.approved_by, p.approved_at, p.paid_at
    FROM payroll p
    WHERE p.faculty_id = $1
    ORDER BY p.payroll_year DESC, p.payroll_month DESC`, [facultyId]);
}

export async function getPayslipDetail(payrollId: number, facultyId?: number): Promise<FacultyPayslip | undefined> {
  const payslip = await queryOne<FacultyPayslip>(`
    SELECT p.payroll_id, p.faculty_id, f.faculty_code, f.first_name || ' ' || f.last_name AS faculty_name,
           p.payroll_month, p.payroll_year,
           to_char(make_date(p.payroll_year, p.payroll_month, 1), 'FMMonth YYYY') AS period_text,
           p.basic_salary, p.allowances, p.deductions, p.leave_deductions, p.net_salary,
           p.status, p.generated_at, p.approved_by, p.approved_at, p.paid_at
    FROM payroll p
    JOIN faculty f USING (faculty_id)
    WHERE p.payroll_id = $1 ${facultyId ? 'AND p.faculty_id = $2' : ''}`,
    facultyId ? [payrollId, facultyId] : [payrollId]);

  if (!payslip) return undefined;
  payslip.items = await query<FacultyPayrollItem>(`
    SELECT payroll_item_id, payroll_id, component_name, component_type, amount
    FROM payroll_item WHERE payroll_id = $1 ORDER BY component_type, component_name`, [payrollId]);
  return payslip;
}

// Admin / HR query helpers
export function getAllLeaveRequests(status?: string): Promise<FacultyLeaveRequest[]> {
  return query<FacultyLeaveRequest>(`
    SELECT lr.leave_request_id, lr.faculty_id, f.faculty_code, f.first_name || ' ' || f.last_name AS faculty_name,
           lr.leave_type_id, lt.leave_name, lr.from_date, lr.to_date, lr.days_requested, lr.reason,
           lr.status, lr.approved_by, u.display_name AS approver_name, lr.approved_at, lr.decision_remarks, lr.created_at
    FROM faculty_leave_request lr
    JOIN faculty f USING (faculty_id)
    JOIN faculty_leave_type lt USING (leave_type_id)
    LEFT JOIN v_user_profile u ON u.user_id = lr.approved_by
    ${status ? 'WHERE lr.status = $1' : ''}
    ORDER BY lr.created_at DESC`, status ? [status] : []);
}

export async function approveLeaveRequest(leaveRequestId: number, adminUserId: number): Promise<void> {
  await query('CALL approve_faculty_leave($1, $2)', [leaveRequestId, adminUserId]);
}

export async function rejectLeaveRequest(leaveRequestId: number, adminUserId: number, remarks: string): Promise<void> {
  await query('CALL reject_faculty_leave($1, $2, $3)', [leaveRequestId, adminUserId, remarks]);
}

export function generateMonthlyPayroll(month: number, year: number) {
  return query<{
    result_month: number;
    result_year: number;
    rows_generated: number;
    rows_skipped_locked: number;
    rows_skipped_no_structure: number;
  }>('SELECT * FROM generate_monthly_payroll($1, $2)', [month, year]);
}

export async function updatePayrollStatus(payrollId: number, status: 'APPROVED' | 'PAID', adminUserId: number): Promise<void> {
  await query('CALL update_payroll_status($1, $2, $3)', [payrollId, status, adminUserId]);
}

