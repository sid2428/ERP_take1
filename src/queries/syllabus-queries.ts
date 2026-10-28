import { query } from '../db.js';

// T3-3 syllabus coverage queries. Progress comes from the views created in migration 042.

export interface UnitProgressRow {
  unit_id: number; unit_no: number; unit_title: string; planned_lectures: number; delivered: number; pct: number;
}

export interface SyllabusSummaryRow {
  planned_total: number; delivered_total: number; units_done: number; units_total: number; pct: number;
}

export interface RecentSessionRow {
  session_id: number; session_date: string; session_number: number; unit_no: number | null; unit_title: string | null;
}

export interface StudentCoverageRow {
  course_id: number; planned_total: number; delivered_total: number; units_done: number; units_total: number; pct: number;
}

/** Planned vs delivered lectures for each unit of one class. */
export async function getUnitProgress(assignmentId: number): Promise<UnitProgressRow[]> {
  const rows = await query<UnitProgressRow>(`
    SELECT unit_id, unit_no, unit_title, planned_lectures, delivered, pct
    FROM v_course_syllabus_progress
    WHERE assignment_id = $1
    ORDER BY unit_no`, [assignmentId]);
  return rows.map((r) => ({ ...r, pct: Number(r.pct) }));
}

/** The overall bar for one class (undefined when the course has no units). */
export async function getSyllabusSummary(assignmentId: number): Promise<SyllabusSummaryRow | undefined> {
  const rows = await query<SyllabusSummaryRow>(`
    SELECT planned_total, delivered_total, units_done, units_total, pct
    FROM v_assignment_syllabus_summary
    WHERE assignment_id = $1`, [assignmentId]);
  return rows[0] ? { ...rows[0], pct: Number(rows[0].pct) } : undefined;
}

/** The latest conducted sessions of a class and the unit each was tagged with. */
export function getRecentSessions(assignmentId: number): Promise<RecentSessionRow[]> {
  return query<RecentSessionRow>(`
    SELECT s.session_id, s.session_date, s.session_number, u.unit_no, u.unit_title
    FROM attendance_session s
    LEFT JOIN syllabus_coverage sc ON sc.session_id = s.session_id
    LEFT JOIN course_unit u ON u.unit_id = sc.unit_id
    WHERE s.assignment_id = $1 AND s.session_status = 'Conducted'
    ORDER BY s.session_date DESC, s.session_number DESC
    LIMIT 10`, [assignmentId]);
}

/** Syllabus % for each of a faculty member's classes in the current session, keyed by assignment id. */
export async function getFacultySyllabusPct(facultyId: number): Promise<Map<number, number>> {
  const rows = await query<{ assignment_id: number; pct: number | string | null }>(`
    SELECT assignment_id, pct
    FROM v_assignment_syllabus_summary
    WHERE faculty_id = $1 AND academic_session_id = current_session_id()`, [facultyId]);
  return new Map(rows.map((r) => [r.assignment_id, Number(r.pct)]));
}

/** What a student sees per enrolled course: coverage of the class they sit in, keyed by course id. */
export async function getStudentSyllabusCoverage(studentId: number): Promise<Map<number, StudentCoverageRow>> {
  const rows = await query<StudentCoverageRow>(`
    SELECT course_id, planned_total, delivered_total, units_done, units_total, pct
    FROM v_student_syllabus_coverage
    WHERE student_id = $1 AND academic_session_id = current_session_id()
    ORDER BY course_id, assignment_id`, [studentId]);
  const byCourse = new Map<number, StudentCoverageRow>();
  for (const r of rows) if (!byCourse.has(r.course_id)) byCourse.set(r.course_id, { ...r, pct: Number(r.pct) });
  return byCourse;
}
