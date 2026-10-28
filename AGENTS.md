# Project guide

## Stack and running
- Main portal: Node.js 20+, TypeScript (strict), Express 5, EJS server-rendered pages, CSS and small browser-side JavaScript.
- Database: PostgreSQL in the `erp` schema (local Docker or Supabase); `pg` with parameterized SQL is used directly. There is no ORM.
- Auth: `express-session` stored in PostgreSQL via `connect-pg-simple`; passwords are scrypt hashes. Roles are `student`, `faculty`, and `admin`.
- Separate fees UI: React 18 + TypeScript + Vite in `client/fee-app`; it is not the main portal renderer.
- Setup details and database options: `SETUP.md`. Typical flow: `npm install`, configure `.env` using `.env.example`, prepare/migrate/load a database as needed, then `npm run dev` (http://localhost:3100).
- Useful checks: `npm test`, `npm run typecheck`, and `npm run build`. See `package.json` for database and data-pipeline scripts.

## Where things live
- `views/student/`, `views/faculty/`, `views/admin/`: role-specific EJS pages; `views/partials/`: shared layout/components.
- `src/lib/nav.ts`: role-based sidebar links; `views/partials/layout-start.ejs` renders them.
- `src/routes/`: Express page/form routes; `src/routes/admin/`: admin routes. `src/routes/student-api-routes.ts` contains student JSON APIs under `/student/api`; student UI templates are in `views/student/` and use `public/js/student-records.js`.
- `src/queries/`: shared, academic, faculty, notice, and grievance SQL queries.
- `migrations/*.sql`: schema, tables, views, triggers, and functions in PostgreSQL schema `erp`; there is no ORM model directory.
- `src/auth/`, `src/middleware/`, `src/routes/auth-routes.ts`: password, session, login, and role checks.
- `client/fee-app/src/`: separate React fees interface; `public/`: main portal static assets.
- `scripts/data/`, `scripts/db/`: dataset generation and database migration/loading/verification; `data/attendance/` and `data/examination/`: Group 3 SQL/data-generation references.
- `tests/`: Vitest unit, HTTP/app, and database tests.

## Logins and roles
- Login IDs are student numbers for students, faculty codes for faculty, and `admin` for the admin account.
- `app_user.role` determines the home route and access: role middleware protects each role's route group. Student/faculty accounts link to their corresponding `student`/`faculty` row.
- Generated non-demo accounts initially use DOB (students) or joining date (faculty), formatted `DDMMYYYY`, and must change the password on first sign-in. Demo student/faculty use `DEMO_PASSWORD`; admin uses `ADMIN_PASSWORD`. Generated credentials are kept in the gitignored `data/generated/demo-credentials.txt`; never commit credentials.

## Attendance and conventions
- Student dashboard totals are queried in `src/routes/student-routes.ts` from `v_student_attendance_overall`; course values come from `getStudentCourses()` in `src/queries/shared-queries.ts` and `v_student_attendance_by_course`.
- Those views derive from `attendance_summary`, maintained from `attendance_session` by database logic in `migrations/006-attendance.sql`. Each session stores `absent_student_ids`; `v_attendance_record` expands it to per-student present/absent rows. Migration `086-attendance-extra-sessions.sql` adds `is_extra`, `reason`, and `created_by` (faculty ID); it preserves existing rows and allows extra sessions alongside a regular session on the same date.
- Tables and columns use lowercase `snake_case`; table names are generally singular (`student`, `faculty`, `attendance_session`). Keys end in `_id`, timestamps in `_at`; boolean flags commonly start with `is_` or `must_`.

## Group 3 database schema
- Attendance tables (already in migrations 004/006): `division` → `department`, `academic_session`; `batch` → `division`; `student_section` → `student`, `academic_session`, `division`, `batch`; `teaching_assignment` → `academic_session`, `course`, `faculty`, `division`/`batch`/`course_offering`; `attendance_session` → `teaching_assignment`, `faculty`, `timetable_entry`; `attendance_summary` → `student`, `course`, `academic_session`, `teaching_assignment`; `attendance_correction` → `attendance_session`, `student`, `faculty`, `app_user`.
- New exam tables in `migrations/084-group3-examination.sql`: `grade_scale` → no existing table; `course_exam_scheme` → `course`; `exam_cycle` → `academic_session`; `exam_schedule` → `exam_cycle`, `course`; `exam_registration` → `student`, `course`, `exam_cycle` (attendance checked from its existing view).
- `hall_ticket` → `student`, `exam_cycle`; `exam_marks` → `student`, `course`, `exam_cycle`, `faculty`; `course_result` → `student`, `course`, `academic_session`, `grade_scale`; `semester_result` → `student`, `academic_session`; `student_cgpa` → `student`.
- Examination migrations: schema `084`, exam logic `085`, marks scheme `088`, and shared result refresh `089`; apply pending migrations with `npm run db:migrate`.
- Bulk merge: `npx tsx scripts/db/load-group3.ts` from the project root. It uses PostgreSQL `COPY` staging and preserves existing records.
- `course.course_type` stores `TH`, `LAB`, and `TUT`. Scheme: `TH` = internal 20 + midsem 20 + endsem 60; `LAB` = internal 50 + practical (stored as endsem) 50, no midsem; `TUT` retains its existing scheme.
- Migration `088` rescales stored marks and recalculates results; `089` defines `refresh_exam_results()`. The loader normalizes legacy TH/LAB maxima and marks, then refreshes course, semester, and CGPA summaries. Marks and results have database maximum guards.
- For future synthetic data, run `python data\examination\generate_exam_data.py` (inputs under `data\attendance` and `data\core\faculty_dataset.xlsx`; output under `data\examination`). On a newly migrated database, load with `npx tsx scripts/db/load-group3.ts`. The loader uses `ON CONFLICT DO NOTHING`; it does not replace existing rows.
- Student joins use integer `student_id` FK; `student_number` is the external identifier. Faculty joins use integer `faculty_id`, not source employee/faculty codes.
- PostgreSQL stores dates as `date`/`timestamptz`, not formatted strings; parse any `DD-MM-YYYY` source values explicitly. Sample faculty joining dates are ISO `YYYY-MM-DD`.
- Source `student_section_mapping` is represented by `student_section`; source `department_id` maps to `dept_id`, `roll_no` remains `roll_no`, and academic-year/term references use `academic_session_id`. Course attendance configuration reuses `course`; see `docs/group3-schema-notes.md`.
- Loader gotchas: `students.csv` is Windows-1252 and is transcoded for COPY; its 50,000 student numbers already exist. All 300 source faculty lack required gender and have no verified portal ID mapping, so 4,722 assignments and 105,970 attendance sessions were withheld; 642,299 marks lacked a mappable `entered_by`. Also reported: 37,324 admission-year mismatches, 1,140 DOB constraint failures, and 158,347 registrations below/missing portal attendance.
- Validation command: read-only SQL via PostgreSQL (`DATABASE_URL`); attendance view had 0 orphan rows and five sampled students matched `attendance_summary`. 10,249 students are below 75% for the current session.

## Module status
- 2a done: attendance/exam schema migrated.
- 2b done: idempotent bulk merge ran; exam data loaded. Attendance source rows were blocked by the faculty mapping gap noted above.
- 2c done: read-only attendance and exam reconciliation checks run; see validation findings above.
- 2d done: student APIs in `src/routes/student-api-routes.ts` include attendance, exams, and results. Results return course type, each available component mark and scheme maximum, total, and grade; queries are scoped to the logged-in student's integer `student_id`.
- 2e done: student frontend pages at `/student/attendance`, `/student/attendance/detail`, `/student/exams`, `/student/hall-ticket`, and `/student/results`; templates in `views/student/`, navigation in `src/lib/nav.ts`, client rendering in `public/js/student-records.js`, styles in `public/css/app.css`.
- The dashboard attendance card already uses DB-backed attendance views. New pages fetch the authenticated student APIs; eligibility is >=75% attendance and `Registered` status. No endpoint or table changes for this UI work.
- Test pages and APIs with `npm test -- tests/app/student-pages.test.ts tests/app/student-api.test.ts`; integration tests require the configured app database and demo credentials.
- Faculty attendance at `/faculty/attendance` uses `attendance_session`; its trigger refreshes `attendance_summary`. Assignment access is scoped to `req.user.facultyId`. `ATTENDANCE_WEEKEND_DAYS` contains ISO weekdays `[6, 7]`; normal dates follow the timetable and extra sessions require a reason.
- Attendance editing uses `LOCK_DAYS = 14` and `UNLOCK_HOURS = 48` from `src/config.ts`; the date window uses `todayIso()` in Asia/Kolkata. Older sessions require an active, session-specific admin approval.
- Migration `087-attendance-unlocks.sql` adds `attendance_unlock_request` (requester, reason, pending/approved/rejected decision and 48-hour expiry) and `attendance_session_audit` (actor, time, old/new values and request ID).
- Faculty APIs: `GET /faculty/attendance/assignments/:assignmentId/sessions` returns lock/request status; `POST /faculty/attendance/assignments/:assignmentId/sessions/:sessionId/unlock-requests` submits a reason; existing attendance `POST .../sessions` saves edits.
- The portal already has the `admin` role/login. `/admin` is protected by `requireRole('admin')`; `/admin/attendance-unlocks` lists pending requests, with `POST /admin/attendance-unlocks/:id/approved` and `/rejected` decisions. Decisions are also role-checked in the query layer.
- Validate with `npm test -- tests/unit/attendance-unlock.test.ts tests/app/faculty-attendance.test.ts tests/app/portal.test.ts`; app tests need the configured database and demo credentials.
- 3b done: faculty marks entry at `/faculty/examination`; UI in `views/faculty/examination.ejs` and `public/js/faculty-examination.js`, styles in `public/css/app.css`, sidebar in `src/lib/nav.ts`.
- Faculty exam APIs in `src/routes/faculty-examination-routes.ts` and `src/queries/faculty-examination-queries.ts`: `GET /faculty/examination/courses`, `GET /faculty/examination/courses/:courseId?exam_cycle_id=...`, and `POST /faculty/examination/courses/:courseId/marks`.
- Saves are scoped to the faculty's current-session course roster and a non-completed cycle; component maxima and applicable fields come from `course_exam_scheme`. Marks, course results, semester results, and student CGPA update in one transaction. Result semester is taken from the assignment division, with roster/curriculum fallbacks (it is not a `course` column).
- Faculty marks UI (`public/js/faculty-examination.js`) displays only applicable components, inline validation, and a live total; student results display component marks/maxima and course type.
- Test examination logic with `npm test -- tests/unit/faculty-examination-marks.test.ts tests/db/group3-examination.test.ts tests/app/faculty-examination.test.ts tests/app/student-api.test.ts`; app/database tests require the configured database and demo credentials. Coverage includes type maxima, lab midsem rejection, valid theory totals, over-max rejection, and SGPA/CGPA consistency. Type-check/build with `npm run typecheck` and `npm run build`.
- 3c done: PostgreSQL logic adapted in `data/examination/exam_logic.sql` and applied by migration 085. Exam registration blocks below 75%; `calculate_cgpa(student_id)` supplies Results API CGPA. Analytical views `v_attendance_defaulters_by_division` and `v_student_cgpa_rank` are queried in `data/examination/analytical_queries.sql`.
- `docs/work-assignments.md` lists other planned student and faculty dashboard/page work.

## Agent instructions
- No repository-specific alternate instruction file (such as `.github/copilot-instructions.md` or `.agent/rules`) was found; this root `AGENTS.md` is the project guide.
