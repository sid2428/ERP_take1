import { Router } from 'express';
import { query, queryOne } from '../../db.js';
import { termProgress, todayIso } from '../../lib/format.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', async (_req, res) => {
  const [totals, byDept, sessions, recent, activity] = await Promise.all([
    queryOne<Record<string, number>>(`
      SELECT (SELECT count(*) FROM student WHERE status = 'Active')    AS active_students,
             (SELECT count(*) FROM student WHERE status = 'Graduated') AS graduated_students,
             (SELECT count(*) FROM student WHERE status = 'Inactive')  AS inactive_students,
             (SELECT count(*) FROM faculty WHERE status = 'Active')    AS faculty,
             (SELECT count(*) FROM department)                         AS departments,
             (SELECT count(*) FROM program)                            AS programs,
             (SELECT count(*) FROM course)                             AS courses,
             (SELECT count(*) FROM program_curriculum)                 AS placements,
             (SELECT count(*) FROM course_prerequisite)                AS prerequisites,
             (SELECT count(*) FROM division WHERE academic_session_id = current_session_id()) AS divisions,
             (SELECT count(*) FROM course_offering WHERE academic_session_id = current_session_id()) AS offerings`),
    query<{ dept_id: string; dept_name: string; students: number; y1: number; y2: number; y3: number; y4: number;
            avg_pct: number | null; shortage_students: number }>(`
      WITH sec AS (
        SELECT d.dept_id, d.year_of_study, ss.student_id
        FROM student_section ss JOIN division d USING (division_id, academic_session_id)
        WHERE ss.academic_session_id = current_session_id()),
      overall AS (SELECT student_id, overall_pct FROM v_student_attendance_overall WHERE academic_session_id = current_session_id())
      SELECT dp.dept_id, dp.dept_name, count(sec.student_id)::int AS students,
             count(*) FILTER (WHERE sec.year_of_study = 1)::int AS y1, count(*) FILTER (WHERE sec.year_of_study = 2)::int AS y2,
             count(*) FILTER (WHERE sec.year_of_study = 3)::int AS y3, count(*) FILTER (WHERE sec.year_of_study = 4)::int AS y4,
             round(avg(o.overall_pct), 1) AS avg_pct,
             count(*) FILTER (WHERE o.overall_pct < 75)::int AS shortage_students
      FROM department dp LEFT JOIN sec ON sec.dept_id = dp.dept_id LEFT JOIN overall o ON o.student_id = sec.student_id
      GROUP BY dp.dept_id, dp.dept_name ORDER BY dp.dept_id`),
    query<{ session_id: string; session_name: string; is_current: boolean }>(
      `SELECT session_id, session_name, is_current FROM academic_session ORDER BY start_date DESC LIMIT 6`),
    query<{ occurred_at: Date; action: string; entity: string; entity_id: string | null; login_id: string | null }>(`
      SELECT a.occurred_at, a.action, a.entity, a.entity_id, u.login_id
      FROM audit_log a LEFT JOIN app_user u USING (user_id) ORDER BY a.audit_id DESC LIMIT 8`),
    queryOne<{ last_date: string | null; week_sessions: number; week_cancelled: number }>(`
      WITH last AS (SELECT max(session_date) AS d FROM attendance_session)
      SELECT (SELECT d FROM last) AS last_date,
             count(*) FILTER (WHERE session_status = 'Conducted')::int AS week_sessions,
             count(*) FILTER (WHERE session_status = 'Cancelled')::int AS week_cancelled
      FROM attendance_session WHERE session_date > (SELECT d FROM last) - 7`),
  ]);
  const current = res.locals.currentSession as { start_date: string; end_date: string } | undefined;
  res.render('admin/dashboard', {
    title: 'Academic administration', nav: 'dashboard', totals, byDept, recent, activity,
    sessions: sessions.reverse(),
    progress: current ? termProgress(current.start_date, current.end_date, todayIso()) : null,
  });
});
