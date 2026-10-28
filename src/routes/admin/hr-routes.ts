import { Router } from 'express';
import { flash } from '../../middleware/auth.js';
import { friendlyDbError } from '../../db.js';
import {
  getAllLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
  getAllPayrolls,
  generateMonthlyPayroll,
  updatePayrollStatus,
  getPayslipDetail,
} from '../../queries/faculty-queries.js';

export const hrAdminRouter = Router();

function idParam(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Invalid ID parameter');
  }
  return n;
}

// 1. LEAVE MANAGEMENT
hrAdminRouter.get('/leave', async (req, res) => {
  const filterStatus = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'PENDING';
  const validStatuses = ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];
  const statusToQuery = filterStatus === 'ALL' ? undefined : (validStatuses.includes(filterStatus) ? filterStatus : 'PENDING');

  const [allRequests, pendingRequests] = await Promise.all([
    getAllLeaveRequests(statusToQuery),
    getAllLeaveRequests('PENDING'),
  ]);

  res.render('admin/leave', {
    title: 'Faculty Leave Management',
    nav: 'leave',
    requests: allRequests,
    pendingCount: pendingRequests.length,
    currentFilter: filterStatus,
  });
});

hrAdminRouter.post('/leave/:id/approve', async (req, res) => {
  const reqId = idParam(req.params.id);
  try {
    await approveLeaveRequest(reqId, req.user!.userId);
    flash(req, 'success', `Leave request #${reqId} has been approved.`);
  } catch (err: any) {
    flash(req, 'error', friendlyDbError(err) ?? (err.message || 'Could not approve leave request.'));
  }
  res.redirect('/admin/leave');
});

hrAdminRouter.post('/leave/:id/reject', async (req, res) => {
  const reqId = idParam(req.params.id);
  const remarks = String(req.body.remarks || 'Rejected by administration').trim();
  try {
    await rejectLeaveRequest(reqId, req.user!.userId, remarks);
    flash(req, 'success', `Leave request #${reqId} has been rejected.`);
  } catch (err: any) {
    flash(req, 'error', friendlyDbError(err) ?? (err.message || 'Could not reject leave request.'));
  }
  res.redirect('/admin/leave');
});

// 2. PAYROLL MANAGEMENT
hrAdminRouter.get('/payroll', async (req, res) => {
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();

  const monthParam = req.query.month ? Number(req.query.month) : undefined;
  const yearParam = req.query.year ? Number(req.query.year) : undefined;
  const statusParam = typeof req.query.status === 'string' && ['DRAFT', 'APPROVED', 'PAID'].includes(req.query.status.toUpperCase())
    ? req.query.status.toUpperCase()
    : undefined;

  const payrolls = await getAllPayrolls(monthParam, yearParam, statusParam);

  res.render('admin/payroll', {
    title: 'Faculty Payroll Administration',
    nav: 'payroll',
    payrolls,
    filterMonth: monthParam || currentMonth,
    filterYear: yearParam || currentYear,
    filterStatus: statusParam || 'ALL',
  });
});

hrAdminRouter.post('/payroll/generate', async (req, res) => {
  const month = Number(req.body.month);
  const year = Number(req.body.year);

  if (!month || !year || month < 1 || month > 12) {
    flash(req, 'error', 'Please provide a valid month (1-12) and year.');
    return res.redirect('/admin/payroll');
  }

  try {
    const result = await generateMonthlyPayroll(month, year);
    const summary = result[0] || { rows_generated: 0, rows_skipped_locked: 0, rows_skipped_no_structure: 0 };
    flash(req, 'success', `Generated payroll for ${summary.rows_generated} faculty member(s) (${summary.rows_skipped_locked} already finalized, ${summary.rows_skipped_no_structure} skipped without active pay scale).`);
  } catch (err: any) {
    flash(req, 'error', friendlyDbError(err) ?? (err.message || 'Could not generate payroll.'));
  }
  res.redirect(`/admin/payroll?month=${month}&year=${year}`);
});

hrAdminRouter.post('/payroll/:id/status', async (req, res) => {
  const payrollId = idParam(req.params.id);
  const status = String(req.body.status || '').toUpperCase();

  if (!['APPROVED', 'PAID'].includes(status)) {
    flash(req, 'error', 'Invalid status. Can only set to APPROVED or PAID.');
    return res.redirect('/admin/payroll');
  }

  try {
    await updatePayrollStatus(payrollId, status as 'APPROVED' | 'PAID', req.user!.userId);
    flash(req, 'success', `Payroll #${payrollId} marked as ${status}.`);
  } catch (err: any) {
    flash(req, 'error', friendlyDbError(err) ?? (err.message || 'Could not update payroll status.'));
  }
  res.redirect('/admin/payroll');
});

hrAdminRouter.get('/payroll/:id', async (req, res) => {
  const payrollId = idParam(req.params.id);
  const payslip = await getPayslipDetail(payrollId);
  if (!payslip) {
    flash(req, 'error', 'Payslip record not found.');
    return res.redirect('/admin/payroll');
  }
  res.render('faculty/payslip-detail', {
    title: `Payslip · ${payslip.period_text}`,
    nav: 'payroll',
    payslip,
  });
});
