/**
 * Demo grievances (T8-2): about 240 grievances from Jul 2026 to today with assignments, replies and
 * outcomes, so the admin queue and the demo accounts have something to show. Deterministic.
 * Runs only when the grievance table is empty, so it never touches real grievances.
 * Re-run after npm run db:load (the load truncates grievances with the accounts).
 *
 * Usage: npm run db:seed-grievances   |   npm run supabase:seed-grievances
 */
import { withClient } from './client.js';

const COUNT = 240;
const FROM = Date.parse('2026-07-01T09:00:00+05:30');
const DAY = 86_400_000;

/** Small seeded PRNG (mulberry32) so every run produces the same data. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const rand = rng(8020);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number): boolean => rand() < p;

type Category = 'Academic' | 'Attendance' | 'Fees' | 'Exam' | 'Facilities' | 'Other';
const WEIGHTS: [Category, number][] = [['Academic', 18], ['Attendance', 22], ['Fees', 14], ['Exam', 16], ['Facilities', 22], ['Other', 8]];

const TEMPLATES: Record<Category, { s: string; d: string }[]> = {
  Academic: [
    { s: 'Elective choice not shown for my program', d: 'The elective page does not list the honors courses announced in class. Please check whether my program is included in the window.' },
    { s: 'Course material not shared for unit 3', d: 'Slides and notes for unit 3 have not been uploaded although the unit was completed last week.' },
    { s: 'Timetable clash between lab and lecture', d: 'My batch lab on Thursday overlaps the lecture of another course I am enrolled in. Please fix the timetable.' },
    { s: 'Request to change division', d: 'I would like to move to another division because of a recurring clash with my honors classes.' },
  ],
  Attendance: [
    { s: 'Marked absent although present', d: 'I was present for the lecture but my attendance shows absent. The faculty member can confirm I answered the roll call.' },
    { s: 'Attendance not updated for medical leave', d: 'I submitted a medical certificate for three days of absence but the attendance percentage has not been corrected.' },
    { s: 'Attendance percentage looks wrong', d: 'The portal shows fewer sessions attended than my own record for this course. Please verify the session list.' },
    { s: 'Lab session missing from my record', d: 'A lab session I attended does not appear at all in my attendance record for the course.' },
  ],
  Fees: [
    { s: 'Payment made but still shown as due', d: 'I paid the first installment by bank transfer but the portal still shows the full amount as outstanding.' },
    { s: 'Late fee charged by mistake', d: 'A late fee was added although the payment was made before the due date. The receipt shows the payment date.' },
    { s: 'Scholarship amount not adjusted', d: 'My scholarship was approved but the fee demand still shows the full general category amount.' },
    { s: 'Fee receipt not generated', d: 'I could not download a receipt for my last payment. Please issue one for my records.' },
  ],
  Exam: [
    { s: 'Request for re-evaluation of answer sheet', d: 'I believe one answer was not evaluated in the end-semester paper. I request a re-evaluation.' },
    { s: 'In-sem marks entered incorrectly', d: 'My in-semester marks shown on the portal do not match the marks shown in class.' },
    { s: 'Exam hall ticket not available', d: 'I cannot download my hall ticket for the upcoming exams although my fees are paid.' },
    { s: 'Clash between two exam slots', d: 'Two of my exams, including a backlog paper, are scheduled in the same slot.' },
  ],
  Facilities: [
    { s: 'Projector not working in classroom', d: 'The projector in our classroom has not worked for over a week, so lectures are being delivered without slides.' },
    { s: 'Lab computers not booting', d: 'Several computers in the programming lab do not boot, so students have to share machines during practicals.' },
    { s: 'Drinking water cooler out of order', d: 'The water cooler on the second floor has been out of order for several days.' },
    { s: 'Wi-Fi unavailable in the library', d: 'The campus Wi-Fi does not connect in the library reading hall, which makes online references impossible to use.' },
    { s: 'Broken chairs in the seminar hall', d: 'Many chairs in the seminar hall are broken and unsafe to sit on.' },
  ],
  Other: [
    { s: 'ID card not received', d: 'I have not yet received my college ID card for this academic year.' },
    { s: 'Bus pass renewal delayed', d: 'My college bus pass renewal is pending for more than two weeks.' },
    { s: 'Portal login issue on mobile', d: 'The portal logs me out repeatedly when I use it on my phone.' },
  ],
};

const OFFICE_REPLIES = [
  'Thank you for raising this. We are checking with the department.',
  'We have forwarded this to the concerned section and will update you shortly.',
  'Could you share the date and course code so we can verify?',
  'This is being looked into. Please allow two working days.',
];
const RAISER_REPLIES = [
  'Thank you. The date was the second week of the month.',
  'Any update on this please?',
  'I have shared the details with the class teacher as well.',
  'Thanks for the quick response.',
];
const ASSIGNEE_REPLIES = [
  'I have checked the records and will confirm the correction with the office.',
  'Verified on my side. The issue is genuine.',
  'I spoke to the student; the details are correct.',
  'The maintenance team has been informed.',
];
const RESOLUTIONS = [
  'The issue has been verified and corrected. Please check the portal.',
  'The concerned section has fixed the problem. Thank you for reporting it.',
  'Correction applied after verification with the department.',
  'Replacement done by the maintenance team.',
];
const REJECTIONS = [
  'After verification the existing record is correct, so no change is needed.',
  'This must be raised with the examination cell through the official form.',
  'The request does not meet the policy requirements.',
];

function category(): Category {
  let r = rand() * WEIGHTS.reduce((s, [, w]) => s + w, 0);
  for (const [c, w] of WEIGHTS) { if ((r -= w) < 0) return c; }
  return 'Other';
}

/** A weekday time between 9:00 and 17:00 IST, `days` after `from`. */
function at(from: number, days: number): number {
  let t = from + days * DAY;
  const d = new Date(t + 5.5 * 3_600_000);
  if (d.getUTCDay() === 0) t += DAY;
  if (d.getUTCDay() === 6) t += 2 * DAY;
  const ist = new Date(t + 5.5 * 3_600_000);
  ist.setUTCHours(9 + Math.floor(rand() * 8), Math.floor(rand() * 60), 0, 0);
  return ist.getTime() - 5.5 * 3_600_000;
}

interface Person { user_id: number; login_id: string; dept_id: string | null; faculty_id: number | null; }

async function main(): Promise<void> {
  await withClient(async (db) => {
    await db.query('SET search_path = erp, public');
    const { rows: [existing] } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM grievance');
    if (existing!.n > 0) {
      console.log(`grievance already has ${existing!.n} rows; nothing seeded`);
      return;
    }
    const people = (sql: string) => db.query<Person>(sql).then((r) => r.rows);
    const students = await people(`SELECT user_id, login_id, dept_id, NULL::int AS faculty_id FROM v_user_profile
      WHERE role = 'student' AND is_active ORDER BY md5(user_id::text) LIMIT 400`);
    const faculty = await people(`SELECT p.user_id, p.login_id, p.dept_id, p.faculty_id FROM v_user_profile p
      JOIN faculty f USING (faculty_id) WHERE p.role = 'faculty' AND p.is_active AND f.status = 'Active' ORDER BY p.login_id`);
    const { rows: [adminRow] } = await db.query<{ user_id: number }>(`SELECT user_id FROM app_user WHERE role = 'admin' ORDER BY user_id LIMIT 1`);
    if (!adminRow || students.length === 0 || faculty.length === 0) throw new Error('load accounts first (npm run data:users, db:load)');
    const admin = adminRow.user_id;
    const demoStudent = (await people(`SELECT user_id, login_id, dept_id, NULL::int AS faculty_id FROM v_user_profile WHERE login_id = 'STU202600004'`))[0];
    const demoFaculty = faculty.find((f) => f.login_id === 'FAC-CSE-074');
    const byDept = new Map<string, Person[]>();
    for (const f of faculty) byDept.set(f.dept_id ?? '', [...(byDept.get(f.dept_id ?? '') ?? []), f]);

    const now = Date.now();
    const span = Math.max(1, Math.floor((now - FROM) / DAY) - 1);

    await db.query('BEGIN');
    try {
      // rows are written complete (stamps, status log) by this script, so the workflow triggers are off for the load
      await db.query('ALTER TABLE grievance DISABLE TRIGGER USER; ALTER TABLE grievance_comment DISABLE TRIGGER USER');
      let comments = 0;
      for (let i = 0; i < COUNT; i++) {
        // the demo accounts get a few grievances of their own, in different states
        const demo = i < 3 && demoStudent ? demoStudent : i === 3 && demoFaculty ? demoFaculty : null;
        const raiser = demo ?? (chance(0.15) ? pick(faculty) : pick(students));
        const role = raiser.faculty_id ? 'faculty' : 'student';
        const cat = demo && i === 3 ? 'Facilities' : category();
        const tpl = pick(TEMPLATES[cat]);
        const ageDays = demo ? [3, 9, 40, 12][i]! : Math.floor(rand() ** 0.8 * span);
        const created = at(FROM + (span - ageDays) * DAY, 0);
        if (created > now) continue;

        // older grievances are mostly closed; recent ones still open or in progress
        const closeChance = ageDays > 21 ? 0.92 : ageDays > 7 ? 0.6 : 0.15;
        let status: 'Open' | 'In progress' | 'Resolved' | 'Rejected' =
          demo ? (['Open', 'In progress', 'Resolved', 'Open'] as const)[i]!
          : chance(closeChance) ? (chance(0.85) ? 'Resolved' : 'Rejected') : chance(0.55) ? 'In progress' : 'Open';

        const pool = (byDept.get(raiser.dept_id ?? '') ?? faculty).filter((f) => f.user_id !== raiser.user_id);
        let assignee: Person | null = status !== 'Open' && chance(0.55) && pool.length ? pick(pool) : null;
        if (demo && i === 1 && demoFaculty) assignee = demoFaculty;               // demo student <-> demo faculty
        if (!demo && demoFaculty && status === 'In progress' && raiser.user_id !== demoFaculty.user_id
            && raiser.dept_id === demoFaculty.dept_id && chance(0.3)) assignee = demoFaculty;

        const startedAt = status === 'Open' ? null : Math.min(now, created + (2 + rand() * 46) * 3_600_000);
        const closedAt = status === 'Resolved' || status === 'Rejected'
          ? Math.min(now, startedAt! + (0.5 + rand() * (cat === 'Facilities' ? 9 : 5)) * DAY) : null;
        if (closedAt !== null && closedAt <= created) status = 'In progress';
        const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
        const closedFinal = status === 'Resolved' || status === 'Rejected' ? closedAt : null;

        const { rows: [g] } = await db.query<{ grievance_id: number }>(
          `INSERT INTO grievance (raised_by, raised_by_role, category, subject, description, status, assigned_to, assigned_at,
                                  resolution_note, resolved_by, created_at, updated_at, resolved_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING grievance_id`,
          [raiser.user_id, role, cat, tpl.s, tpl.d, status, assignee?.faculty_id ?? null, assignee ? iso(startedAt) : null,
            closedFinal ? pick(status === 'Resolved' ? RESOLUTIONS : REJECTIONS) : null, closedFinal ? admin : null,
            iso(created), iso(closedFinal ?? startedAt ?? created), iso(closedFinal)]);
        const id = g!.grievance_id;

        const log = [[null, 'Open', raiser.user_id, created]] as [string | null, string, number, number][];
        if (startedAt !== null) log.push(['Open', 'In progress', admin, startedAt]);
        if (closedFinal !== null) log.push(['In progress', status, admin, closedFinal]);
        for (const [from, to, by, t] of log) {
          await db.query(`INSERT INTO grievance_status_log (grievance_id, from_status, to_status, changed_by, changed_at)
                          VALUES ($1, $2, $3, $4, $5)`, [id, from, to, by, iso(t)]);
        }

        // replies between being picked up and being closed
        if (startedAt !== null) {
          const end = closedFinal ?? now;
          const n = Math.floor(rand() * 4);
          let t = startedAt;
          for (let k = 0; k < n; k++) {
            t += rand() * Math.max(1, end - t) * 0.6;
            if (t >= end) break;
            const who = k === 0 ? 'office' : assignee && chance(0.5) ? 'assignee' : chance(0.5) ? 'raiser' : 'office';
            const [author, body] = who === 'office' ? [admin, pick(OFFICE_REPLIES)]
              : who === 'assignee' ? [assignee!.user_id, pick(ASSIGNEE_REPLIES)] : [raiser.user_id, pick(RAISER_REPLIES)];
            await db.query('INSERT INTO grievance_comment (grievance_id, author_id, body, created_at) VALUES ($1, $2, $3, $4)',
              [id, author, body, iso(t)]);
            comments++;
          }
        }
      }
      await db.query('ALTER TABLE grievance ENABLE TRIGGER USER; ALTER TABLE grievance_comment ENABLE TRIGGER USER');
      await db.query('COMMIT');
      const { rows: [n] } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM grievance');
      console.log(`seeded ${n!.n} grievances with ${comments} replies`);
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
