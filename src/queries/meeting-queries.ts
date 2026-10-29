import { query, queryOne } from '../db.js';

export interface DepartmentMeeting {
  meeting_id: number;
  dept_id: string;
  dept_name?: string;
  created_by_faculty_id: number;
  created_by_name?: string;
  title: string;
  agenda: string;
  meeting_date: string;
  start_time: string;
  end_time: string;
  venue: string;
  meeting_link: string | null;
  target_audience: 'faculty' | 'student' | 'all';
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED';
  cancel_reason: string | null;
  created_at: string;
  total_invited?: number;
  accepted_count?: number;
  declined_count?: number;
  my_status?: 'INVITED' | 'ACCEPTED' | 'DECLINED' | null;
}

export interface CreateMeetingInput {
  title: string;
  agenda: string;
  meeting_date: string;
  start_time: string;
  end_time: string;
  venue: string;
  meeting_link?: string;
  target_audience: 'faculty' | 'student' | 'all';
}

/**
 * All meetings for an HOD's department with RSVP statistics.
 */
export async function getDepartmentMeetings(deptId: string): Promise<DepartmentMeeting[]> {
  return query<DepartmentMeeting>(
    `SELECT m.meeting_id, m.dept_id, d.dept_name, m.created_by_faculty_id,
            (f.first_name || ' ' || f.last_name) AS created_by_name, m.title, m.agenda,
            to_char(m.meeting_date, 'YYYY-MM-DD') AS meeting_date,
            to_char(m.start_time, 'HH24:MI') AS start_time,
            to_char(m.end_time, 'HH24:MI') AS end_time,
            m.venue, m.meeting_link, m.target_audience, m.status, m.cancel_reason,
            m.created_at::text,
            count(p.user_id)::int AS total_invited,
            count(p.user_id) FILTER (WHERE p.status = 'ACCEPTED')::int AS accepted_count,
            count(p.user_id) FILTER (WHERE p.status = 'DECLINED')::int AS declined_count
     FROM department_meeting m
     JOIN department d ON d.dept_id = m.dept_id
     JOIN faculty f ON f.faculty_id = m.created_by_faculty_id
     LEFT JOIN department_meeting_participant p ON p.meeting_id = m.meeting_id
     WHERE m.dept_id = $1
     GROUP BY m.meeting_id, d.dept_name, f.first_name, f.last_name
     ORDER BY m.meeting_date DESC, m.start_time DESC`,
    [deptId]
  );
}

/**
 * Meetings relevant to a faculty member in their department.
 */
export async function getFacultyMeetings(userId: number, deptId: string): Promise<DepartmentMeeting[]> {
  return query<DepartmentMeeting>(
    `SELECT m.meeting_id, m.dept_id, d.dept_name, m.created_by_faculty_id,
            (f.first_name || ' ' || f.last_name) AS created_by_name, m.title, m.agenda,
            to_char(m.meeting_date, 'YYYY-MM-DD') AS meeting_date,
            to_char(m.start_time, 'HH24:MI') AS start_time,
            to_char(m.end_time, 'HH24:MI') AS end_time,
            m.venue, m.meeting_link, m.target_audience, m.status, m.cancel_reason,
            m.created_at::text,
            p.status AS my_status
     FROM department_meeting m
     JOIN department d ON d.dept_id = m.dept_id
     JOIN faculty f ON f.faculty_id = m.created_by_faculty_id
     LEFT JOIN department_meeting_participant p ON p.meeting_id = m.meeting_id AND p.user_id = $1
     WHERE m.dept_id = $2 AND m.target_audience IN ('faculty', 'all')
     ORDER BY m.meeting_date DESC, m.start_time DESC`,
    [userId, deptId]
  );
}

/**
 * Meetings relevant to a student in their department.
 */
export async function getStudentMeetings(userId: number, deptId: string): Promise<DepartmentMeeting[]> {
  return query<DepartmentMeeting>(
    `SELECT m.meeting_id, m.dept_id, d.dept_name, m.created_by_faculty_id,
            (f.first_name || ' ' || f.last_name) AS created_by_name, m.title, m.agenda,
            to_char(m.meeting_date, 'YYYY-MM-DD') AS meeting_date,
            to_char(m.start_time, 'HH24:MI') AS start_time,
            to_char(m.end_time, 'HH24:MI') AS end_time,
            m.venue, m.meeting_link, m.target_audience, m.status, m.cancel_reason,
            m.created_at::text,
            p.status AS my_status
     FROM department_meeting m
     JOIN department d ON d.dept_id = m.dept_id
     JOIN faculty f ON f.faculty_id = m.created_by_faculty_id
     LEFT JOIN department_meeting_participant p ON p.meeting_id = m.meeting_id AND p.user_id = $1
     WHERE m.dept_id = $2 AND m.target_audience IN ('student', 'all')
     ORDER BY m.meeting_date DESC, m.start_time DESC`,
    [userId, deptId]
  );
}

/**
 * Create a department meeting as HOD.
 */
export async function createDepartmentMeeting(
  deptId: string,
  hodFacultyId: number,
  data: CreateMeetingInput
): Promise<number> {
  const isHod = await queryOne<{ hod_faculty_id: number }>(
    'SELECT hod_faculty_id FROM department WHERE dept_id = $1 AND hod_faculty_id = $2',
    [deptId, hodFacultyId]
  );
  if (!isHod) {
    throw new Error('Only the Head of Department can schedule department meetings.');
  }

  const row = await queryOne<{ meeting_id: number }>(
    `INSERT INTO department_meeting
       (dept_id, created_by_faculty_id, title, agenda, meeting_date, start_time, end_time, venue, meeting_link, target_audience)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING meeting_id`,
    [
      deptId,
      hodFacultyId,
      data.title.trim(),
      data.agenda.trim(),
      data.meeting_date,
      data.start_time,
      data.end_time,
      data.venue.trim(),
      data.meeting_link?.trim() || null,
      data.target_audience,
    ]
  );

  return row!.meeting_id;
}

/**
 * Cancel a department meeting.
 */
export async function cancelDepartmentMeeting(
  meetingId: number,
  hodFacultyId: number,
  deptId: string,
  cancelReason: string
): Promise<void> {
  const isHod = await queryOne<{ hod_faculty_id: number }>(
    'SELECT hod_faculty_id FROM department WHERE dept_id = $1 AND hod_faculty_id = $2',
    [deptId, hodFacultyId]
  );
  if (!isHod) {
    throw new Error('Only the Head of Department can cancel department meetings.');
  }

  await query(
    `UPDATE department_meeting
     SET status = 'CANCELLED', cancel_reason = $1
     WHERE meeting_id = $2 AND dept_id = $3`,
    [cancelReason.trim() || 'Cancelled by HOD', meetingId, deptId]
  );
}

/**
 * RSVP response for an invited attendee.
 */
export async function rsvpDepartmentMeeting(
  meetingId: number,
  userId: number,
  status: 'ACCEPTED' | 'DECLINED'
): Promise<void> {
  await query(
    `INSERT INTO department_meeting_participant (meeting_id, user_id, role, status, responded_at)
     SELECT $1, $2, u.role, $3, now()
     FROM app_user u WHERE u.user_id = $2
     ON CONFLICT (meeting_id, user_id)
     DO UPDATE SET status = EXCLUDED.status, responded_at = now()`,
    [meetingId, userId, status]
  );
}
