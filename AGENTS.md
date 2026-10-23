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
- Those views derive from `attendance_summary`, maintained from `attendance_session` by database logic in `migrations/006-attendance.sql`. Each session stores `absent_student_ids`; `v_attendance_record` expands it to per-student present/absent rows. Dashboard figures are database-backed; records are generated/synthetic.
- Tables and columns use lowercase `snake_case`; table names are generally singular (`student`, `faculty`, `attendance_session`). Keys end in `_id`, timestamps in `_at`; boolean flags commonly start with `is_` or `must_`.

## Group 3 database schema
- Attendance tables (already in migrations 004/006): `division` → `department`, `academic_session`; `batch` → `division`; `student_section` → `student`, `academic_session`, `division`, `batch`; `teaching_assignment` → `academic_session`, `course`, `faculty`, `division`/`batch`/`course_offering`; `attendance_session` → `teaching_assignment`, `faculty`, `timetable_entry`; `attendance_summary` → `student`, `course`, `academic_session`, `teaching_assignment`; `attendance_correction` → `attendance_session`, `student`, `faculty`, `app_user`.
- New exam tables in `migrations/084-group3-examination.sql`: `grade_scale` → no existing table; `course_exam_scheme` → `course`; `exam_cycle` → `academic_session`; `exam_schedule` → `exam_cycle`, `course`; `exam_registration` → `student`, `course`, `exam_cycle` (attendance checked from its existing view).
- `hall_ticket` → `student`, `exam_cycle`; `exam_marks` → `student`, `course`, `exam_cycle`, `faculty`; `course_result` → `student`, `course`, `academic_session`, `grade_scale`; `semester_result` → `student`, `academic_session`; `student_cgpa` → `student`.
- Examination schema migration: `migrations/084-group3-examination.sql`; Group 3 logic migration: `migrations/085-group3-exam-logic.sql`; apply pending migrations with `npm run db:migrate`.
- Bulk merge: `npx tsx scripts/db/load-group3.ts` from the project root. It uses PostgreSQL `COPY` staging and preserves existing records.
- Student joins use integer `student_id` FK; `student_number` is the external identifier. Faculty joins use integer `faculty_id`, not source employee/faculty codes.
- PostgreSQL stores dates as `date`/`timestamptz`, not formatted strings; parse any `DD-MM-YYYY` source values explicitly. Sample faculty joining dates are ISO `YYYY-MM-DD`.
- Source `student_section_mapping` is represented by `student_section`; source `department_id` maps to `dept_id`, `roll_no` remains `roll_no`, and academic-year/term references use `academic_session_id`. Course attendance configuration reuses `course`; see `docs/group3-schema-notes.md`.
- Loader gotchas: `students.csv` is Windows-1252 and is transcoded for COPY; its 50,000 student numbers already exist. All 300 source faculty lack required gender and have no verified portal ID mapping, so 4,722 assignments and 105,970 attendance sessions were withheld; 642,299 marks lacked a mappable `entered_by`. Also reported: 37,324 admission-year mismatches, 1,140 DOB constraint failures, and 158,347 registrations below/missing portal attendance.
- Loaded exam rows: 8 grade scales, 182 course schemes, 11 cycles, 320 schedules, 91,523 registrations, 39,993 hall tickets, 52,689 marks, 435,130 course results, 59,854 semester results, and 30,008 CGPA rows.
- Validation command: read-only SQL via PostgreSQL (`DATABASE_URL`); attendance view had 0 orphan rows and five sampled students matched `attendance_summary`. 10,249 students are below 75% for the current session.
- Exam validation gotcha: all 52,689 retained `exam_marks` rows are in the non-completed cycle; there are 0 completed-cycle marks for 435,130 course results. Semester/CGPA backlog and semester counts matched, but source course credits were not retained in `course_result`, so credit/SGPA/CGPA reconciliation against `course.credits` is only an approximation.

## Module status
- 2a done: attendance/exam schema migrated.
- 2b done: idempotent bulk merge ran; exam data loaded. Attendance source rows were blocked by the faculty mapping gap noted above.
- 2c done: read-only attendance and exam reconciliation checks run; see validation findings above.
- 2d done: student read-only APIs are in `src/routes/student-api-routes.ts`: `GET /student/api/attendance`, `GET /student/api/attendance/:courseId?page=1`, `GET /student/api/exams`, and `GET /student/api/results`. All scope queries to the logged-in student's integer `student_id`; attendance detail uses 25-row pages.
- 2e done: student frontend pages at `/student/attendance`, `/student/attendance/detail`, `/student/exams`, `/student/hall-ticket`, and `/student/results`; templates in `views/student/`, navigation in `src/lib/nav.ts`, client rendering in `public/js/student-records.js`, styles in `public/css/app.css`.
- The dashboard attendance card already uses DB-backed attendance views. New pages fetch the authenticated student APIs; eligibility is >=75% attendance and `Registered` status. No endpoint or table changes for this UI work.
- Test pages and APIs with `npm test -- tests/app/student-pages.test.ts tests/app/student-api.test.ts`; integration tests require the configured app database and demo credentials.
- 3a done: faculty attendance page at `/faculty/attendance`; UI in `views/faculty/attendance.ejs`, `public/js/faculty-attendance.js`, and `public/css/app.css`. `src/routes/faculty-attendance-routes.ts` provides `GET /faculty/attendance/assignments`, `GET .../:assignmentId/roster?date=YYYY-MM-DD`, `GET .../:assignmentId/sessions`, and `POST .../:assignmentId/sessions`.
- Attendance writes reuse `attendance_session`; its trigger refreshes `attendance_summary`, which feeds student attendance APIs/views. There is no `attendance_records` table. Faculty identity comes from `app_user.faculty_id` as `req.user.facultyId`; every assignment read/write checks that ID.
- Test with `npm test -- tests/app/faculty-attendance.test.ts`; it verifies ownership and create/edit + summary refresh in a rolled-back transaction.
- 3b done: faculty marks entry at `/faculty/examination`; UI in `views/faculty/examination.ejs` and `public/js/faculty-examination.js`, styles in `public/css/app.css`, sidebar in `src/lib/nav.ts`.
- Faculty exam APIs in `src/routes/faculty-examination-routes.ts` and `src/queries/faculty-examination-queries.ts`: `GET /faculty/examination/courses`, `GET /faculty/examination/courses/:courseId?exam_cycle_id=...`, and `POST /faculty/examination/courses/:courseId/marks`.
- Saves are scoped to the faculty's current-session course roster and a non-completed cycle; component marks are checked against `course_exam_scheme`, then `exam_marks` and `course_result` are updated transactionally using `grade_scale`. No table or migration was added. Result semester is taken from the assignment division, with roster/curriculum fallbacks (it is not a `course` column).
- Validate with `npm run build` and `npm test -- tests/app/faculty-examination.test.ts tests/app/faculty-attendance.test.ts tests/app/student-api.test.ts`; browser script syntax: `node --check public\js\faculty-examination.js`.
- 3c done: PostgreSQL logic adapted in `data/examination/exam_logic.sql` and applied by migration 085. Exam registration blocks below 75%; `calculate_cgpa(student_id)` supplies Results API CGPA. Analytical views `v_attendance_defaulters_by_division` and `v_student_cgpa_rank` are queried in `data/examination/analytical_queries.sql`.
- Test Group 3 database logic and Results API with `npm test -- tests/db/group3-examination.test.ts tests/app/student-api.test.ts`; database tests require `DATABASE_URL`. Type-check/build with `npm run typecheck` and `npm run build`.
- `docs/work-assignments.md` lists other planned student and faculty dashboard/page work.

## Agent instructions
- No repository-specific alternate instruction file (such as `.github/copilot-instructions.md` or `.agent/rules`) was found; this root `AGENTS.md` is the project guide.
