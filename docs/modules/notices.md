# Notices (T8-1)

The academic office posts notices to any audience; faculty post to the divisions they teach. Every
student and faculty member has a notice board, an unread count, and a "Notices" card on their
dashboard. Other modules post system notices through the `post_notice(...)` contract.

Migration: `migrations/081-notices.sql` · Seed: `scripts/db/seed-notices.ts` ·
Routes: `src/routes/notice-routes.ts` (student + faculty), `src/routes/admin/notice-routes.ts` ·
Queries: `src/queries/notice-queries.ts` · Tests: `tests/db/notice.test.ts`, `tests/app/notice.test.ts`

## Audiences

A notice has one or more **targets**. A target narrows the audience with optional filters, and a
notice reaches a person when **any** of its targets matches them:

| Target | Reaches |
|---|---|
| `{}` | everyone (students, faculty, admin) |
| `{role}` | everyone with that role |
| `{dept_id}` / `{dept_id, role}` | students of the department's programs and/or its faculty |
| `{year_of_study}` (+ `dept_id`) | students in that year this session (optionally one department) |
| `{division_id}` | the students of that division this session |

Year and division come from the student's division in the **current session**, so a year-2 notice
reaches whoever is in year 2 now. Year and division targets are always student targets.

## Tables

| Table | Key | Purpose |
|---|---|---|
| `notice` | `notice_id` | title, body, category (General / Academic / Exam / Fees / Placement / Event), important flag, poster (NULL = system), posted, expires, withdrawn (when, by whom) |
| `notice_target` | `target_id` | the audience filters (FKs to `department`, `division`) |
| `notice_read` | `(user_id, notice_id)` | who has read what, and when |

## Rules and where they are enforced

| Rule | Where |
|---|---|
| Only the admin, faculty or the system (NULL) post | trigger `guard` on `notice` |
| Faculty post only to divisions they teach this session | trigger `audience_guard` on `notice_target` |
| Year/division targets describe students (role filled in automatically) | `CHECK` + trigger `audience_guard` |
| A division target doesn't also name a department or year | `CHECK` |
| Every notice has at least one target | deferred constraint trigger `has_audience` (checked at commit) |
| A posted notice cannot be edited; its audience cannot change after the posting transaction | triggers `guard`, `audience_guard` |
| Only the poster or an admin withdraws; withdrawing is final | trigger `guard` |
| Expiry is after posting; title ≥ 5, body 10–5,000 characters | `CHECK`s (and zod in the routes) |
| Only recipients can mark a notice read | trigger `recipient_only` on `notice_read` |
| Every post / withdraw runs in a transaction and adds an `audit_log` row (`NOTICE_*`) | routes |

## Views and functions

**`v_user_audience`**: each active account with role, department, and (students) this session's year and division.

**`v_user_notices`**: every live notice (not withdrawn, not expired) for each user, with read status. Contract `v_user_notices(user_id)`.
```sql
SELECT title, category, posted_by_name, is_read FROM erp.v_user_notices WHERE user_id = 42 ORDER BY posted_at DESC;
```

**`v_notice_reach`**: recipients and reads per notice. The ~50k accounts are grouped into a few hundred audience groups first, so a page of 25 notices takes about half a second.
```sql
SELECT notice_id, recipients, reads FROM erp.v_notice_reach WHERE notice_id = 7;
```

**`notice_target_matches(target, audience)`**: does a target describe a person?

**`post_notice(posted_by, title, body, category, targets jsonb, is_important = false, expires_at = NULL) → notice_id`**: the contract for every team. `posted_by` NULL marks a system notice.
```sql
-- T5 when results are published
SELECT erp.post_notice(NULL, 'Semester V results published', 'Results are on the results page.', 'Exam',
                       '[{"role": "student", "dept_id": "CSE", "year_of_study": 3}]');
-- a faculty member to two divisions
SELECT erp.post_notice(42, 'Lab moved', 'Thursday lab is in A-204.', 'Academic',
                       '[{"division_id": 17}, {"division_id": 18}]');
```

## Pages

| Who | URL | What |
|---|---|---|
| Student | `/student/notices`, `/:id` | board with category chips, unread dots, mark all read; opening a notice marks it read |
| Faculty | `/faculty/notices`, `/new`, `/:id` | board, **Posted by me** with reads, post to taught divisions (checkboxes), withdraw |
| Student, faculty | dashboard | "Notices" card: latest four and the unread count |
| Admin | `/admin/notices` | every notice with audience, reads / recipients and status (live / expired / withdrawn), filters |
| Admin | `/admin/notices/new` | post with audience picker: everyone, a role, a department, a year, or division codes |
| Admin | `/admin/notices/:id` | notice, reach, read %, withdraw |

## Seed data

`npm run db:seed-notices` (local) or `npm run supabase:seed-notices` adds 39 deterministic notices
(Jul 2026 to today) from the office, 12 faculty members and the system, with a capped sample of
reads (~0.9 MB). It runs only when `notice` is empty. Re-run it after `npm run db:load`.

## Demo script (3 minutes)

1. Sign in as **admin** → *Notices* → **Post a notice**. Choose **Divisions** and enter `IT-Y3-A`
   (the demo student's division). The confirmation shows how many students it reached.
2. Sign in as **STU202600004**: the notice is on the dashboard card with an unread dot and on the
   board. Open it, and it is marked read.
3. Sign in as **FAC-CSE-074**: the notice is not on their board (it went to students of one division).
   Post a notice to one of the divisions they teach; only those divisions are offered.
4. Back as **admin**: the list shows reads / recipients; open the faculty notice and **Withdraw** it.
   It disappears from the students' boards. *Audit log* shows `NOTICE_POST` and `NOTICE_WITHDRAW`.

## Automatic notices and alerts (`migrations/082-automatic-notices.sql`)

The portal tells people what they would expect to hear without anyone posting by hand.

**Personal notices** (stored, addressed to one account through a `user_id` target, with an **Open →** link):

| Event | Who is told | Link |
|---|---|---|
| Grievance raised | the admin (Inbox) | `/admin/grievances/:id` |
| Grievance assigned | the faculty member, and the raiser ("being handled") | their grievance page |
| Moved to In progress without assignment | the raiser | `/…/grievances/:id` |
| New reply | every other participant (raiser, assignee, admin) | their grievance page |
| Resolved / rejected | the raiser (with the note), and the assignee | their grievance page |

These are posted by triggers on `grievance` and `grievance_comment` through
**`notify_user(user_id, title, body, category, link, source)`**, which any module can call. Personal
notices expire after 60 days. Opening one through `/…/notices/:id/go` marks it read and jumps to the link.

**Live status alerts** (computed by **`user_alerts(user_id)`** each time, never stored; shown under
*Needs your attention* on the board and on the dashboard card, and they disappear once fixed):

| Alert | Source |
|---|---|
| Attendance below the minimum in N courses, with sessions needed per course | `v_student_attendance_by_course` (T4) |
| Fees pending / overdue with the amount and due date | `v_student_fee_status` (T6 contract): switches on automatically once T6 creates it |

**Exam hooks for T5** (important notices to students, optionally one department and year):
```sql
SELECT erp.post_exam_timetable_notice('End-semester timetable published', 'Exams start on 24 Nov.', 'CSE', 3::smallint);
SELECT erp.post_results_notice('Semester V results published', 'Check the results page.', 'CSE', 3::smallint);
```

Admin: personal alerts are kept out of the announcements list (filter *Automatic personal alerts*),
and the admin's own alerts are in **Inbox** (`/admin/inbox`) and on the admin dashboard.
