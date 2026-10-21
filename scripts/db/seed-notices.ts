/**
 * Demo notices (T8-1): about 45 notices from Jul 2026 to today from the academic office, faculty
 * (to divisions they teach) and the system, with some expired or withdrawn and a sample of reads.
 * Deterministic. Runs only when the notice table is empty, so it never touches real notices.
 * Re-run after npm run db:load (the load truncates notices together with the accounts).
 *
 * Usage: npm run db:seed-notices   |   npm run supabase:seed-notices
 */
import { withClient } from './client.js';

const FROM = Date.parse('2026-07-01T10:00:00+05:30');
const DAY = 86_400_000;

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const rand = rng(8110);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

type Target = { role?: string; dept_id?: string; year_of_study?: number; division_id?: number };
interface Seed { title: string; body: string; category: string; important?: boolean; targets: Target[]; days?: number }

const OFFICE: Seed[] = [
  { title: 'Welcome to the Odd Semester 2026-27', category: 'General', important: true, targets: [{}],
    body: 'Classes for the odd semester begin on Monday. Timetables are available on the portal under your dashboard. Please check your division and lab batch.' },
  { title: 'Fee installment 1 due on 15 August', category: 'Fees', important: true, targets: [{ role: 'student' }],
    body: 'The first installment (50%) of the 2026-27 fees is due on 15 August. A late fee of Rs 500 applies after 30 days and Rs 1,500 after 90 days.' },
  { title: 'Independence Day celebration', category: 'Event', targets: [{}],
    body: 'All students and staff are invited to the flag hoisting ceremony on 15 August at 8:00 am on the main ground.' },
  { title: 'In-semester examination schedule', category: 'Exam', important: true, targets: [{ role: 'student' }],
    body: 'In-semester examinations will be held in the last week of September. The detailed schedule per course is published on the notice board and the portal.' },
  { title: 'Library hours extended during exams', category: 'General', targets: [{ role: 'student' }],
    body: 'The central library will remain open until 10:00 pm from 20 September to 5 October.' },
  { title: 'Minimum attendance reminder', category: 'Academic', targets: [{ role: 'student' }],
    body: 'Students must maintain at least 75% attendance in every course. Check your attendance on the dashboard and meet your class teacher if you are below the minimum.' },
  { title: 'Faculty development programme on outcome-based education', category: 'Academic', targets: [{ role: 'faculty' }],
    body: 'A two-day FDP on outcome-based education will be held in the seminar hall. All faculty members are requested to attend.' },
  { title: 'Submission of course files', category: 'Academic', targets: [{ role: 'faculty' }],
    body: 'Faculty members are requested to submit updated course files for the current term to their HODs by the end of the month.' },
  { title: 'Campus placement drive: registrations open', category: 'Placement', important: true, targets: [{ role: 'student', year_of_study: 4 }],
    body: 'Final-year students can register for the upcoming campus drives. Update your placement profile and resume link before registering.' },
  { title: 'Internship opportunities for third-year students', category: 'Placement', targets: [{ role: 'student', year_of_study: 3 }],
    body: 'Several companies are offering summer internships. Interested third-year students should contact the training and placement cell.' },
  { title: 'Mini-project topic approval', category: 'Academic', targets: [{ role: 'student', year_of_study: 2 }],
    body: 'Second-year students must submit their mini-project topics to their guides for approval within two weeks.' },
  { title: 'Induction programme for first-year students', category: 'Event', targets: [{ role: 'student', year_of_study: 1 }],
    body: 'The induction programme for first-year students runs for one week and includes campus tours, talks and activities.' },
  { title: 'Annual technical festival', category: 'Event', targets: [{}],
    body: 'Registrations for the annual technical festival are open. Teams can participate in coding, robotics and paper presentation events.' },
  { title: 'Scholarship applications', category: 'Fees', targets: [{ role: 'student' }],
    body: 'Eligible students can apply for government scholarships on the state portal. Submit the printed application to the scholarship section.' },
  { title: 'Diwali vacation', category: 'General', targets: [{}],
    body: 'The college remains closed for the Diwali vacation. Classes resume on the Monday after the vacation as per the academic calendar.' },
  { title: 'Hall tickets for end-semester examinations', category: 'Exam', targets: [{ role: 'student' }],
    body: 'Hall tickets for the end-semester examinations can be downloaded from the portal once all dues are cleared.' },
];
const DEPT_NOTICES = [
  { title: 'Department meeting', body: 'All faculty of the department are requested to attend the department meeting on Friday at 3:30 pm.', role: 'faculty', category: 'General' },
  { title: 'Guest lecture by industry expert', body: 'A guest lecture on current industry practices is scheduled in the department seminar hall. Attendance is compulsory.', role: '', category: 'Event' },
  { title: 'Department lab maintenance', body: 'Department labs will be closed on Saturday for maintenance. Practicals are rescheduled by the respective faculty.', role: 'student', category: 'Academic' },
];
const FACULTY_NOTICES = [
  { title: 'Extra lecture on Saturday', body: 'An extra lecture will be held on Saturday at 10:00 am to complete the syllabus of unit 3.' },
  { title: 'Assignment 2 submission', body: 'Assignment 2 must be submitted by Friday. Late submissions will not be accepted without a valid reason.' },
  { title: 'Lab moved to another room', body: 'This week the lab session will be held in the second-floor lab instead of the usual room.' },
  { title: 'Unit test next week', body: 'A unit test on units 1 and 2 will be conducted in the regular lecture slot next week.' },
  { title: 'Lecture cancelled tomorrow', body: 'Tomorrow\'s lecture is cancelled. The session will be compensated next week.' },
];
const SYSTEM: Seed[] = [
  { title: 'Fee installment 1 overdue: late fee applies', category: 'Fees', targets: [{ role: 'student' }],
    body: 'The first fee installment is overdue. A late fee of Rs 500 now applies. Please clear your dues to avoid further charges.' },
  { title: 'In-semester marks published', category: 'Exam', targets: [{ role: 'student' }],
    body: 'In-semester marks for this term have been published. Check the results page for your course-wise marks.' },
];

async function main(): Promise<void> {
  await withClient(async (db) => {
    await db.query('SET search_path = erp, public');
    const { rows: [existing] } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM notice');
    if (existing!.n > 0) {
      console.log(`notice already has ${existing!.n} rows; nothing seeded`);
      return;
    }
    const { rows: [adminRow] } = await db.query<{ user_id: number }>(`SELECT user_id FROM app_user WHERE role = 'admin' ORDER BY user_id LIMIT 1`);
    if (!adminRow) throw new Error('load accounts first (npm run data:users, db:load)');
    const admin = adminRow.user_id;
    const depts = (await db.query<{ dept_id: string }>('SELECT dept_id FROM department WHERE is_active ORDER BY dept_id')).rows.map((r) => r.dept_id);
    // faculty with the divisions they teach this term (the demo faculty member first)
    const teachers = (await db.query<{ user_id: number; divisions: number[] }>(`
      SELECT u.user_id, array_agg(DISTINCT ta.division_id ORDER BY ta.division_id) AS divisions
      FROM app_user u JOIN teaching_assignment ta ON ta.faculty_id = u.faculty_id
      WHERE ta.academic_session_id = current_session_id() AND ta.division_id IS NOT NULL AND u.is_active
      GROUP BY u.user_id, u.login_id ORDER BY (u.login_id = 'FAC-CSE-074') DESC, md5(u.login_id) LIMIT 12`)).rows;

    const now = Date.now();
    const span = Math.max(10, Math.floor((now - FROM) / DAY));
    const items: (Seed & { by: number | null; at: number })[] = [];
    OFFICE.forEach((s, i) => items.push({ ...s, by: admin, at: FROM + Math.floor(((i + 0.5) / OFFICE.length) * span) * DAY }));
    for (const d of depts) {
      const t = pick(DEPT_NOTICES);
      items.push({ title: `${d}: ${t.title}`, body: t.body, category: t.category, by: admin, at: FROM + Math.floor(rand() * span) * DAY,
        targets: [{ dept_id: d, ...(t.role ? { role: t.role } : {}) }] });
    }
    teachers.forEach((f, i) => {
      const n = i === 0 ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const t = FACULTY_NOTICES[(i + k) % FACULTY_NOTICES.length]!;
        const divs = f.divisions.slice(0, 1 + Math.floor(rand() * Math.min(2, f.divisions.length)));
        items.push({ title: t.title, body: t.body, category: 'Academic', by: f.user_id,
          at: now - (2 + Math.floor(rand() * 40)) * DAY - k * DAY, targets: divs.map((d) => ({ division_id: d })) });
      }
    });
    SYSTEM.forEach((s, i) => items.push({ ...s, by: null, at: FROM + Math.floor((0.55 + 0.3 * i) * span) * DAY }));

    await db.query('BEGIN');
    try {
      // rows are written complete (past dates, reads) by this script, so the posting triggers are off for the load
      await db.query('ALTER TABLE notice DISABLE TRIGGER USER; ALTER TABLE notice_target DISABLE TRIGGER USER; ALTER TABLE notice_read DISABLE TRIGGER USER');
      let reads = 0;
      for (const [i, it] of items.sort((a, b) => a.at - b.at).entries()) {
        const at = Math.min(it.at + Math.floor(rand() * 7) * 3_600_000, now - 3_600_000);
        // events and exams expire a few weeks later; two old notices were withdrawn
        const expires = it.category === 'Event' || it.category === 'Exam' ? at + 21 * DAY : null;
        const withdrawn = i === 5 || i === 17 ? at + 2 * DAY : null;
        const { rows: [n] } = await db.query<{ notice_id: number }>(
          `INSERT INTO notice (title, body, category, is_important, posted_by, posted_at, expires_at, withdrawn_at, withdrawn_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING notice_id`,
          [it.title, it.body, it.category, it.important ?? false, it.by, new Date(at).toISOString(),
            expires ? new Date(expires).toISOString() : null, withdrawn && withdrawn < now ? new Date(withdrawn).toISOString() : null,
            withdrawn && withdrawn < now ? (it.by ?? admin) : null]);
        for (const t of it.targets) {
          const role = t.role ?? (t.year_of_study || t.division_id ? 'student' : null);
          await db.query('INSERT INTO notice_target (notice_id, role, dept_id, year_of_study, division_id) VALUES ($1, $2, $3, $4, $5)',
            [n!.notice_id, role, t.dept_id ?? null, t.year_of_study ?? null, t.division_id ?? null]);
        }
        // a sample of recipients has read it (older notices more), capped to keep the table small
        const share = Math.min(0.8, 0.15 + (now - at) / DAY / 120);
        const r = await db.query(`
          INSERT INTO notice_read (notice_id, user_id, read_at)
          SELECT $1, a.user_id, LEAST(now(), $2::timestamptz + (abs(hashint4(a.user_id)) % 72) * interval '1 hour')
          FROM v_user_audience a
          WHERE EXISTS (SELECT 1 FROM notice_target t WHERE t.notice_id = $1 AND notice_target_matches(t, a))
            AND abs(hashint4(a.user_id + $1)) % 1000 < $3
          ORDER BY hashint4(a.user_id + $1) LIMIT 400`, [n!.notice_id, new Date(at).toISOString(), Math.round(share * 1000)]);
        reads += r.rowCount ?? 0;
      }
      await db.query('ALTER TABLE notice ENABLE TRIGGER USER; ALTER TABLE notice_target ENABLE TRIGGER USER; ALTER TABLE notice_read ENABLE TRIGGER USER');
      await db.query('COMMIT');
      console.log(`seeded ${items.length} notices with ${reads} reads`);
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, '<connection-url>') : err);
  process.exit(1);
});
