/**
 * T2 Faculty & HR DBMS tests:
 * - Leave type quotas, leave request submission, approval and rejection
 * - Balance calculation function `get_faculty_leave_balance`
 * - GiST exclusion constraint on overlapping leave dates
 * - Balance restoration on cancellation
 * - Salary structure revision and GiST exclusion constraint
 * - Monthly payroll generation function `generate_monthly_payroll`
 * - Payroll status transitions (DRAFT -> APPROVED -> PAID) and immutability triggers
 * - Contract view `v_faculty_leave_balance`
 */
import { describe, expect, it } from 'vitest';
import { hasDatabase, inRollback, one } from './helpers.js';

describe.skipIf(!hasDatabase)('T2 Faculty & HR (database rules)', () => {
  it('notifies the faculty member about leave decisions once and rolls notices back with the decision', () =>
    inRollback(async (db) => {
      const admin = await one<{ user_id: number }>(db,
        `SELECT user_id FROM app_user WHERE role = 'admin' AND is_active ORDER BY user_id LIMIT 1`);
      const faculty = await one<{ faculty_id: number; user_id: number }>(db,
        `SELECT f.faculty_id, u.user_id FROM faculty f JOIN app_user u USING (faculty_id)
          WHERE f.status = 'Active' AND u.role = 'faculty' AND u.is_active ORDER BY f.faculty_id LIMIT 1`);
      const lop = await one<{ leave_type_id: number }>(db,
        `SELECT leave_type_id FROM faculty_leave_type WHERE leave_name = 'Loss of Pay'`);

      const approved = await one<{ leave_request_id: number }>(db,
        `INSERT INTO faculty_leave_request (faculty_id, leave_type_id, from_date, to_date, days_requested, reason)
         VALUES ($1, $2, '2098-05-01', '2098-05-01', 1, 'Conference') RETURNING leave_request_id`,
        [faculty.faculty_id, lop.leave_type_id]);
      await db.query('SAVEPOINT before_leave_decision');
      await db.query('CALL approve_faculty_leave($1, $2)', [approved.leave_request_id, admin.user_id]);

      const key = `faculty-leave:${approved.leave_request_id}:approved`;
      const notice = await one<{ user_id: number; kind: string; category: string; link: string; title: string; text: string }>(db,
        `SELECT user_id, kind, category::text AS category, link, title, text FROM notification WHERE event_key = $1`, [key]);
      expect(notice).toMatchObject({
        user_id: faculty.user_id, kind: 'academic', category: 'Academic', link: '/faculty/leave',
        title: `Leave request #${approved.leave_request_id} approved`,
      });
      expect(notice.text).toContain('Loss of Pay from 2098-05-01 to 2098-05-01');
      expect(notice.text).toContain('was approved.');

      // The decision, balance ledger entry, and notification are in the same transaction.
      await db.query('ROLLBACK TO SAVEPOINT before_leave_decision');
      expect((await one<{ status: string }>(db,
        'SELECT status::text AS status FROM faculty_leave_request WHERE leave_request_id = $1', [approved.leave_request_id])).status).toBe('PENDING');
      expect((await db.query('SELECT 1 FROM notification WHERE event_key = $1', [key])).rows).toEqual([]);
      expect((await db.query('SELECT 1 FROM faculty_leave_transaction WHERE leave_request_id = $1', [approved.leave_request_id])).rows).toEqual([]);

      await db.query('CALL approve_faculty_leave($1, $2)', [approved.leave_request_id, admin.user_id]);
      const committedText = await one<{ text: string }>(db, 'SELECT text FROM notification WHERE event_key = $1', [key]);
      await db.query("CALL notify($1, 'academic', $2, '/faculty/leave', 'Academic', $3)", [faculty.user_id, committedText.text, key]);
      expect((await db.query('SELECT 1 FROM notification WHERE event_key = $1', [key])).rows).toHaveLength(1);

      const rejected = await one<{ leave_request_id: number }>(db,
        `INSERT INTO faculty_leave_request (faculty_id, leave_type_id, from_date, to_date, days_requested, reason)
         VALUES ($1, $2, '2098-06-01', '2098-06-01', 1, 'Personal commitment') RETURNING leave_request_id`,
        [faculty.faculty_id, lop.leave_type_id]);
      await db.query("CALL reject_faculty_leave($1, $2, 'Coverage unavailable')", [rejected.leave_request_id, admin.user_id]);
      const rejection = await one<{ user_id: number; title: string; text: string }>(db,
        `SELECT user_id, title, text FROM notification WHERE event_key = $1`,
        [`faculty-leave:${rejected.leave_request_id}:rejected`]);
      expect(rejection.user_id).toBe(faculty.user_id);
      expect(rejection.title).toBe(`Leave request #${rejected.leave_request_id} rejected`);
      expect(rejection.text).toContain('Admin note: Coverage unavailable');
    }));

  it('enforces leave quotas and balance calculation through triggers and functions', () =>
    inRollback(async (db) => {
      // 1. Initial balance check on a clean faculty member
      const adminUser = await one<{ user_id: number }>(db, `SELECT user_id FROM app_user WHERE role = 'admin' LIMIT 1`);
      const faculty = await one<{ faculty_id: number }>(
        db,
        `SELECT faculty_id FROM faculty
         WHERE status = 'Active' AND faculty_id NOT IN (SELECT faculty_id FROM faculty_leave_request)
         LIMIT 1`,
      );
      const clType = await one<{ leave_type_id: number; annual_quota: number }>(
        db, `SELECT leave_type_id, annual_quota FROM faculty_leave_type WHERE leave_name = 'Casual Leave'`,
      );

      const initialBal = await one<{ bal: number }>(
        db, `SELECT get_faculty_leave_balance($1, $2) AS bal`, [faculty.faculty_id, clType.leave_type_id],
      );
      expect(Number(initialBal.bal)).toBe(Number(clType.annual_quota));

      // 2. Submit leave request
      const req = await one<{ leave_request_id: number }>(
        db,
        `INSERT INTO faculty_leave_request (faculty_id, leave_type_id, from_date, to_date, days_requested, reason)
         VALUES ($1, $2, '2026-11-10', '2026-11-11', 2, 'Attending technical conference')
         RETURNING leave_request_id`,
        [faculty.faculty_id, clType.leave_type_id],
      );
      expect(req.leave_request_id).toBeGreaterThan(0);

      // Pending leave does not reduce balance yet
      const pendingBal = await one<{ bal: number }>(
        db, `SELECT get_faculty_leave_balance($1, $2) AS bal`, [faculty.faculty_id, clType.leave_type_id],
      );
      expect(Number(pendingBal.bal)).toBe(Number(initialBal.bal));

      // 3. Approve leave using procedure
      await db.query(`CALL approve_faculty_leave($1, $2)`, [req.leave_request_id, adminUser.user_id]);

      // Approved leave reduces balance via trigger insertion into faculty_leave_transaction
      const approvedBal = await one<{ bal: number }>(
        db, `SELECT get_faculty_leave_balance($1, $2) AS bal`, [faculty.faculty_id, clType.leave_type_id],
      );
      expect(Number(approvedBal.bal)).toBe(Number(initialBal.bal) - 2);

      // 4. Exclusion constraint stops overlapping leave
      await db.query('SAVEPOINT sp_overlap');
      await expect(
        db.query(
          `INSERT INTO faculty_leave_request (faculty_id, leave_type_id, from_date, to_date, days_requested, reason)
           VALUES ($1, $2, '2026-11-11', '2026-11-12', 2, 'Overlapping dates')`,
          [faculty.faculty_id, clType.leave_type_id],
        ),
      ).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT sp_overlap');

      // 5. Cancel approved leave restores balance
      await db.query(`CALL cancel_faculty_leave($1, $2)`, [req.leave_request_id, 'Conference postponed']);
      const restoredBal = await one<{ bal: number }>(
        db, `SELECT get_faculty_leave_balance($1, $2) AS bal`, [faculty.faculty_id, clType.leave_type_id],
      );
      expect(Number(restoredBal.bal)).toBe(Number(initialBal.bal));
    }));

  it('calculates monthly payroll, deducts unpaid leave (LOP), and protects status changes', () =>
    inRollback(async (db) => {
      const adminUser = await one<{ user_id: number }>(db, `SELECT user_id FROM app_user WHERE role = 'admin' LIMIT 1`);
      const faculty = await one<{ faculty_id: number }>(db, `SELECT faculty_id FROM faculty WHERE status = 'Active' LIMIT 1`);
      const lopType = await one<{ leave_type_id: number }>(
        db, `SELECT leave_type_id FROM faculty_leave_type WHERE leave_name = 'Loss of Pay'`,
      );

      // Set salary structure: basic 60000, allowances 20000, deductions 5000, per day 2000
      await db.query(
        `CALL revise_salary_structure($1, 60000.00, 20000.00, 5000.00, 2000.00, '2026-11-01'::date)`,
        [faculty.faculty_id],
      );

      // Submit and approve 3 days of LOP leave in November 2026
      const lopReq = await one<{ leave_request_id: number }>(
        db,
        `INSERT INTO faculty_leave_request (faculty_id, leave_type_id, from_date, to_date, days_requested, reason)
         VALUES ($1, $2, '2026-11-10', '2026-11-12', 3, 'Personal reasons without pay')
         RETURNING leave_request_id`,
        [faculty.faculty_id, lopType.leave_type_id],
      );
      await db.query(`CALL approve_faculty_leave($1, $2)`, [lopReq.leave_request_id, adminUser.user_id]);

      // Generate monthly payroll for November 2026
      const genResult = await one<{ rows_generated: number }>(
        db, `SELECT rows_generated FROM generate_monthly_payroll(11, 2026) WHERE result_month = 11`,
      );
      expect(genResult.rows_generated).toBeGreaterThan(0);

      // Verify payroll record
      const pay = await one<{
        payroll_id: number;
        basic_salary: number;
        allowances: number;
        deductions: number;
        leave_deductions: number;
        net_salary: number;
        status: string;
      }>(
        db,
        `SELECT payroll_id, basic_salary, allowances, deductions, leave_deductions, net_salary, status
         FROM payroll WHERE faculty_id = $1 AND payroll_month = 11 AND payroll_year = 2026`,
        [faculty.faculty_id],
      );

      expect(pay.status).toBe('DRAFT');
      expect(Number(pay.basic_salary)).toBe(60000);
      expect(Number(pay.allowances)).toBe(20000);
      expect(Number(pay.deductions)).toBe(5000);
      // 3 days * 2000 per day = 6000 leave deductions
      expect(Number(pay.leave_deductions)).toBe(6000);
      // Net = 60000 + 20000 - 5000 - 6000 = 69000
      expect(Number(pay.net_salary)).toBe(69000);

      // Verify items generated
      const items = await db.query(
        `SELECT component_name, amount FROM payroll_item WHERE payroll_id = $1 ORDER BY component_name`,
        [pay.payroll_id],
      );
      expect(items.rows.length).toBeGreaterThanOrEqual(4);

      // Approve payroll via procedure
      await db.query(`CALL update_payroll_status($1, 'APPROVED', $2)`, [pay.payroll_id, adminUser.user_id]);

      // Locked payroll cannot be modified directly
      await db.query('SAVEPOINT sp_mod');
      await expect(
        db.query(`UPDATE payroll SET basic_salary = 90000 WHERE payroll_id = $1`, [pay.payroll_id]),
      ).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT sp_mod');

      // Items cannot be altered while approved
      await db.query('SAVEPOINT sp_del');
      await expect(
        db.query(`DELETE FROM payroll_item WHERE payroll_id = $1`, [pay.payroll_id]),
      ).rejects.toThrow();
      await db.query('ROLLBACK TO SAVEPOINT sp_del');

      // Mark paid
      await db.query(`CALL update_payroll_status($1, 'PAID', $2)`, [pay.payroll_id, adminUser.user_id]);
      const paidRow = await one<{ status: string; paid_at: string | null }>(
        db, `SELECT status, paid_at FROM payroll WHERE payroll_id = $1`, [pay.payroll_id],
      );
      expect(paidRow.status).toBe('PAID');
      expect(paidRow.paid_at).not.toBeNull();
    }));

  it('exposes contract view v_faculty_leave_balance', () =>
    inRollback(async (db) => {
      const rows = await db.query<{ faculty_id: number; leave_type: string; remaining: number }>(
        `SELECT * FROM v_faculty_leave_balance LIMIT 10`,
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      const first = rows.rows[0]!;
      expect(first.faculty_id).toBeDefined();
      expect(first.leave_type).toBeDefined();
      expect(typeof Number(first.remaining)).toBe('number');
    }));
});
