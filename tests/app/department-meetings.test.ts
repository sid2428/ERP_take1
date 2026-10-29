import { beforeAll, describe, expect, it } from 'vitest';
import { hasAppEnv, postForm, signIn } from './helpers.js';

const DEMO = process.env.DEMO_PASSWORD ?? '';
const HOD = 'FAC-CSE-001';
const FACULTY = 'FAC-CSE-074';
const CSE_STUDENT = 'STU202600005';
const IT_STUDENT = 'STU202600004';

const { createApp } = hasAppEnv ? await import('../../src/app.js') : { createApp: null };
const { query, queryOne } = hasAppEnv ? await import('../../src/db.js') : { query: null, queryOne: null };

describe.skipIf(!hasAppEnv)('HOD Department Meetings & RSVPs', () => {
  const app = hasAppEnv ? createApp!() : (null as unknown as ReturnType<NonNullable<typeof createApp>>);
  type Agent = Awaited<ReturnType<typeof signIn>>['agent'];
  let hodAgent: Agent;
  let facAgent: Agent;
  let cseStuAgent: Agent;
  let itStuAgent: Agent;

  beforeAll(async () => {
    await query!(
      "UPDATE app_user SET password_hash = (SELECT password_hash FROM app_user WHERE login_id = 'STU202600004'), must_change_password = false WHERE login_id = $1",
      [CSE_STUDENT]
    );
    hodAgent = (await signIn(app, HOD, DEMO)).agent;
    facAgent = (await signIn(app, FACULTY, DEMO)).agent;
    cseStuAgent = (await signIn(app, CSE_STUDENT, DEMO)).agent;
    itStuAgent = (await signIn(app, IT_STUDENT, DEMO)).agent;
  });

  it('1. HOD accesses /faculty/meetings and sees scheduling form', async () => {
    const res = await hodAgent.get('/faculty/meetings');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Department Meetings');
    expect(res.text).toContain('Schedule Department Meeting');
    expect(res.text).toContain('action="/faculty/meetings/schedule"');
  });

  it('2. Regular faculty accesses /faculty/meetings and cannot see scheduling form', async () => {
    const res = await facAgent.get('/faculty/meetings');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Department Meetings');
    expect(res.text).not.toContain('Schedule Department Meeting');
  });

  it('3. Regular faculty is rejected with 403 when trying to schedule meeting', async () => {
    const res = await postForm(facAgent, '/faculty/meetings', '/faculty/meetings/schedule', {
      target_audience: 'faculty',
      title: 'Unauthorized meeting',
      agenda: 'Should fail with 403',
      meeting_date: '2026-11-20',
      start_time: '10:00',
      end_time: '11:00',
      venue: 'Room 101',
    });
    expect(res.status).toBe(403);
  });

  it('4. HOD schedules a meeting for department faculty', async () => {
    const title = 'CSE Faculty Council: Syllabus Review';
    const res = await postForm(hodAgent, '/faculty/meetings', '/faculty/meetings/schedule', {
      target_audience: 'faculty',
      title,
      agenda: 'Review syllabus coverage and upcoming internal assessments.',
      meeting_date: '2026-11-25',
      start_time: '11:00',
      end_time: '12:30',
      venue: 'CSE Conference Hall A-201',
      meeting_link: 'https://meet.google.com/cse-fac-rev',
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/faculty/meetings');

    // Follow redirect
    const page = await hodAgent.get('/faculty/meetings');
    expect(page.text).toContain(title);
    expect(page.text).toContain('CSE Conference Hall A-201');

    // Verify DB entry and notification creation for department faculty
    const meeting = await queryOne!<{ meeting_id: number }>(
      'SELECT meeting_id FROM department_meeting WHERE title = $1', [title]
    );
    expect(meeting).toBeDefined();

    const participants = await query!<{ count: number }>(
      'SELECT count(*)::int as count FROM department_meeting_participant WHERE meeting_id = $1',
      [meeting!.meeting_id]
    );
    expect(participants?.[0]?.count).toBeGreaterThan(0);
  });

  it('5. Regular faculty sees the meeting invitation and can RSVP', async () => {
    const page = await facAgent.get('/faculty/meetings');
    expect(page.text).toContain('CSE Faculty Council: Syllabus Review');

    const meeting = await queryOne!<{ meeting_id: number }>(
      "SELECT meeting_id FROM department_meeting WHERE title = 'CSE Faculty Council: Syllabus Review'"
    );

    const rsvpRes = await postForm(facAgent, '/faculty/meetings', `/faculty/meetings/${meeting!.meeting_id}/rsvp`, {
      status: 'ACCEPTED',
    });
    expect(rsvpRes.status).toBe(302);

    const afterRsvp = await facAgent.get('/faculty/meetings');
    expect(afterRsvp.text).toContain('ACCEPTED');
  });

  it('6. HOD schedules a meeting for department students', async () => {
    const title = 'CSE Student HOD Open House';
    const res = await postForm(hodAgent, '/faculty/meetings', '/faculty/meetings/schedule', {
      target_audience: 'student',
      title,
      agenda: 'Direct discussion with HOD regarding lab facilities and placement preparation.',
      meeting_date: '2026-11-28',
      start_time: '14:00',
      end_time: '15:30',
      venue: 'Auditorium',
    });
    expect(res.status).toBe(302);

    // IT student from outside CSE does NOT see the meeting
    const itPage = await itStuAgent.get('/student/meetings');
    expect(itPage.status).toBe(200);
    expect(itPage.text).not.toContain(title);

    // CSE student sees the meeting on /student/meetings
    const stuPage = await cseStuAgent.get('/student/meetings');
    expect(stuPage.status).toBe(200);
    expect(stuPage.text).toContain(title);
    expect(stuPage.text).toContain('Auditorium');

    // Student RSVPs
    const meeting = await queryOne!<{ meeting_id: number }>(
      'SELECT meeting_id FROM department_meeting WHERE title = $1', [title]
    );

    const stuRsvp = await postForm(cseStuAgent, '/student/meetings', `/student/meetings/${meeting!.meeting_id}/rsvp`, {
      status: 'ACCEPTED',
    });
    expect(stuRsvp.status).toBe(302);

    const afterStuRsvp = await cseStuAgent.get('/student/meetings');
    expect(afterStuRsvp.text).toContain('ACCEPTED');
  });

  it('7. HOD can cancel a scheduled meeting', async () => {
    const meeting = await queryOne!<{ meeting_id: number }>(
      "SELECT meeting_id FROM department_meeting WHERE title = 'CSE Student HOD Open House'"
    );

    const cancelRes = await postForm(hodAgent, '/faculty/meetings', `/faculty/meetings/${meeting!.meeting_id}/cancel`, {
      cancel_reason: 'Rescheduled due to guest lecture',
    });
    expect(cancelRes.status).toBe(302);

    const page = await hodAgent.get('/faculty/meetings');
    expect(page.text).toContain('CANCELLED');
    expect(page.text).toContain('Rescheduled due to guest lecture');
  });
});
