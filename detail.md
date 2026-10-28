# PICT Student ERP Portal - Detailed Project Documentation

## 1. Project overview

PICT Student ERP Portal is an academic ERP web application created as a DBMS course
project. It combines academic, student, attendance, examination, finance, faculty,
communication, grievance, and placement workflows in one PostgreSQL-backed portal.

The project is designed for three authenticated roles:

- **Student** - views academic records and uses student services.
- **Faculty** - manages teaching, attendance, examination marks, leave, and related
  faculty workflows.
- **Admin / academic office** - manages the academic structure, people, approvals,
  communication, audit information, and system administration.

The application uses synthetic or generated data and is not an official PICT system.
The repository also contains source datasets and generated fixtures used for local
development and DBMS evaluation.

## 2. Main goals

The project aims to:

1. Integrate several group datasets into a single relational database.
2. Provide a usable role-based college portal.
3. Keep important business rules in PostgreSQL constraints, triggers, views, and
   functions rather than relying only on the browser.
4. Give students a single place to see attendance, examinations, results, fees,
   curriculum, notices, grievances, and placement information.
5. Demonstrate data loading, reconciliation, auditability, and automated testing.
6. Preserve student privacy by deriving the student identity from the authenticated
   session instead of accepting a student ID from the browser.

## 3. Technology stack

| Layer | Technology |
|---|---|
| Server runtime | Node.js 20 or newer |
| Backend | Express 5, TypeScript in strict mode |
| Database | PostgreSQL 17, using the `erp` schema |
| Database access | `pg` with parameterized SQL; there is no ORM |
| Server-rendered UI | EJS templates |
| Client-side behavior | Small browser JavaScript modules and CSS |
| Separate fees UI | React 18, TypeScript, Vite |
| Authentication | `express-session`, PostgreSQL session store, scrypt password hashes |
| Validation | Zod and database constraints |
| Tests | Vitest, Supertest, database and HTTP tests |
| Data processing | Python 3.11+, pandas, CSV and spreadsheet processing |
| Optional hosting | Vercel for the Node application and Supabase PostgreSQL |

## 4. Repository structure

```text
src/
  app.ts                  Express application setup and middleware
  server.ts               Local server entry point
  config.ts               Environment validation and runtime configuration
  auth/                   Password and authentication helpers
  middleware/             Login, role, flash, and request middleware
  routes/                 Express page and API routes
  queries/                Shared SQL query modules
  lib/                    Navigation, formatting, audit, pagination, and helpers

views/
  student/                Student EJS pages
  faculty/                Faculty EJS pages
  admin/                  Admin EJS pages
  partials/               Shared layout and UI components

public/
  css/                    Main portal styles
  js/                     Browser-side scripts

client/fee-app/
  src/                    React fee and D-Wallet application

migrations/
  *.sql                   Numbered database schema and logic migrations

scripts/
  data/                   Dataset cleaning, generation, and reporting
  db/                     Migration, loading, verification, seeding, and account tools

data/
  generated/              Generated database import files
  attendance/             Attendance data and generation references
  examination/            Examination data and generation references
  reports/                Dataset cleanup and generation reports

tests/
  app/                    HTTP and route tests
  db/                     Database rules and integration tests
  unit/                   Unit tests

docs/
  modules/                Module data rules and demonstration notes
  mockups/                Original UI mockups
  reference/              Original group reference material
  deployment.md           Deployment guidance
  evaluation-demo.md      Cross-role evaluation walkthrough
  roadmap.md              Project history and planned work
```

## 5. System architecture

The main portal is a server-rendered Express application:

1. A user sends a request to the Express application.
2. Session middleware loads the authenticated user from PostgreSQL.
3. Login and role middleware protect the relevant route group.
4. A route calls a typed query helper using parameterized SQL.
5. PostgreSQL applies constraints, foreign keys, views, triggers, and stored
   functions.
6. The route renders an EJS page or returns JSON.
7. Small browser-side scripts fetch APIs and update tables, cards, filters, and
   pagination.

The fees interface is a separate React/Vite client under `client/fee-app`. It is
built into the public assets and provides the fee statement, payment-related UI,
receipt, and D-Wallet experience.

### Database design principles

- The database is organized under the dedicated `erp` schema.
- Tables use lowercase `snake_case` names.
- Foreign keys connect students, faculty, courses, sections, academic sessions,
  exams, fees, and transactions.
- Views provide portal-friendly representations of attendance, examination,
  results, receipts, and analytics.
- Triggers refresh derived totals and record important changes.
- Portal users connect through a least-privilege application role that can use
  data but cannot change the schema.
- SQL values are passed as parameters rather than concatenated into queries.

## 6. Database and data pipeline

### Academic source data

The academic source of truth includes:

- Departments
- Programs
- Courses
- Course prerequisites
- Academic sessions
- Program curricula
- Course offerings
- Divisions and batches
- Student sections
- Timetables and rooms
- Teaching assignments

The data pipeline cleans and integrates group data into files under
`data/generated/`. The loader uses PostgreSQL `COPY` staging where appropriate and
is designed to preserve existing records through conflict-safe inserts.

### Important database safeguards

The database contains rules for:

- Timetable clash prevention for rooms, faculty, divisions, and batches.
- One current academic session.
- Prerequisite-cycle rejection using a recursive CTE trigger.
- Course-offering seat limits.
- Composite relationships such as a batch belonging to its division.
- Valid attendance session dates, durations, rosters, and statuses.
- Attendance summary refreshes after attendance changes.
- Exam component maximums and result maximums.
- Attendance eligibility for examination registration.
- Non-negative and non-overpaid fee balances.
- Idempotent payment application and append-only wallet transactions.
- Audit records for important portal changes.

### Database commands

```powershell
npm run data:build
npm run data:users
npm run db:migrate
npm run db:load
npm run db:verify
```

The full local setup, Docker instructions, environment variables, and dataset
requirements are documented in [SETUP.md](SETUP.md).

## 7. Authentication and authorization

The portal supports `student`, `faculty`, and `admin` roles.

- Students log in with their student number.
- Faculty log in with their faculty code.
- The admin account uses the admin login ID.
- Generated non-demo student and faculty accounts initially use a date-based
  password and must change it after the first sign-in.
- Passwords are stored as scrypt hashes.
- Sessions are stored in PostgreSQL using `connect-pg-simple`.
- Role middleware prevents users from opening another role's route group.
- Student database queries use `req.user.studentId`, not a client-provided student
  ID.

The generated credentials file is intentionally not reproduced in this document.
It is a local, gitignored development artifact; passwords should be shared
privately and never committed or placed in documentation.

## 8. Student module - detailed description

The student module is the most complete end-user experience in the portal. It
provides a personalized academic dashboard and student self-service pages. Every
student API is scoped to the logged-in student's internal integer `student_id`.

### Student navigation

The student sidebar currently contains:

- Dashboard
- Notices
- Placement
- Curriculum
- Course offerings
- Electives
- Attendance Summary
- Attendance Detail
- Exam Schedule
- Hall Ticket
- Results
- Profile
- Fees & D-Wallet
- Grievances

The navigation is defined centrally in `src/lib/nav.ts`, so only implemented
student surfaces are shown as active links.

### Student dashboard

The dashboard combines the student's personal and academic context, including:

- Student identity and profile information.
- Current academic session and term progress.
- Course and curriculum information.
- Attendance overview.
- Next class or timetable information.
- Notices and recent communication.
- Shortcuts to attendance, examinations, results, fees, grievances, and placement.

Attendance totals on the dashboard come from database-backed attendance views
rather than browser-calculated values.

### Student profile

The profile page displays information linked to the authenticated student record,
such as the student's number, name, program, academic identity, and related
section information. It does not use a URL student ID to decide whose profile is
shown.

### Curriculum and course offerings

Students can inspect:

- Their program curriculum.
- Courses associated with the current academic session.
- Course codes, names, types, credits, and related academic details.
- Available course offerings and section context.

Course information is sourced from shared academic queries and the normalized
course, curriculum, offering, division, batch, and section tables.

### Electives

The elective experience allows a student to:

- View elective offerings available to the student.
- See whether an elective choice window is open.
- Submit ranked choices when allowed.
- Review the saved elective result.

Elective changes are saved transactionally and audited. Database rules enforce
the relevant foreign keys and elective-window conditions.

### Attendance summary

The page `/student/attendance` presents current-session attendance grouped into
theory and laboratory courses.

For each course, the API can return:

- Course ID
- Course code
- Course name
- Course type
- Attended sessions
- Total sessions
- Attendance percentage
- Whether the percentage is below 75 percent

The summary reads from `attendance_summary` and the shared student attendance
views. Laboratory courses are separated from other courses to make the student
view easier to understand.

### Attendance detail

The page `/student/attendance/detail` lets a student inspect individual
attendance records for a selected course.

The detail API:

- Checks that the course belongs to the authenticated student.
- Returns present/absent records from `v_attendance_record`.
- Orders records from newest to oldest.
- Supports page-based pagination.
- Rejects invalid page numbers.
- Does not reveal another student's records even if a different course ID is
  supplied.

Attendance is stored compactly: each attendance session stores absent student IDs,
while `v_attendance_record` expands the data into student-level records for
queries and display. Faculty edits update summaries through database logic.

### Examination schedule

The page `/student/exams` displays scheduled exams for the authenticated student,
including:

- Exam cycle and academic session.
- Exam type and cycle status.
- Course code and course name.
- Registration status.
- Exam mode.
- Exam date and session.
- Start and end time.
- Attendance percentage.
- Hall-ticket status and number where available.

The API also exposes explicit eligibility flags:

- `attendance_eligible`: attendance is at least 75 percent.
- `hall_ticket_eligible`: registration status is `Registered` and attendance is
  at least 75 percent.

### Hall ticket

The hall-ticket workflow is available at `/student/hall-ticket`.

A hall ticket can be generated only when:

1. The student has an examination cycle with scheduled registered exams.
2. The relevant exam registration is `Registered`.
3. Attendance for the course is at least 75 percent.

The generation operation is transactional and locks the relevant student and
registration rows. It prevents duplicate tickets, respects a withheld status,
creates a stable hall-ticket number, records the issue date, and records the
number of eligible and blocked courses.

The generated hall-ticket view includes:

- Hall-ticket number and issue date.
- Student number and name.
- Program.
- Division and roll number when available.
- Exam cycle and type.
- Eligible course list.
- Exam date, session, and time for each eligible course.

### Results

The student results API returns three levels of academic information:

#### Course marks

- Internal marks and maximum.
- Mid-semester marks and maximum.
- End-semester marks and maximum.
- End-semester status.
- Course type.
- Examination cycle and attempt number.

#### Course results

- Total marks and maximum.
- Percentage.
- Grade and grade points.
- Result status.
- Final-attempt flag.
- Semester and academic session.
- Individual component marks and maximums.

#### Semester and cumulative results

- Credits registered.
- Credits earned.
- SGPA.
- Backlog count.
- Semester result status.
- Semesters completed.
- Credits attempted.
- Cumulative credits earned.
- CGPA.

The result calculations are backed by examination tables, grade scale rules, the
`refresh_exam_results()` function, semester summaries, and `calculate_cgpa()`.
Students can only retrieve their own results.

### Fees and D-Wallet

The student fee page is a separate finance surface integrated into the student
navigation. It provides:

- Fee statement.
- Total, paid, and outstanding amounts.
- Fee status.
- Payment history.
- Receipts.
- Wallet balance.
- D-Wallet transaction history.

Amounts are stored in paise. A successful verified payment updates the fee record,
receipt data, and wallet ledger transactionally. Payment application is idempotent
so replaying the same verified gateway event does not double-apply the payment.
Payment credentials and live gateway secrets are not documented here.

### Notices

Students can view notices targeted to their audience. Notice records support
publication and audience filtering. Attendance shortage notifications and finance
notifications are event-keyed so repeated source changes do not create duplicate
notifications.

### Grievances

The grievance area allows students to submit and track issues through the shared
grievance workflow. Records are associated with the authenticated user and can be
handled by authorized faculty or admin users.

### Placement

The student placement area exposes student-relevant placement information and
opportunities. The placement data is backed by placement queries and seeded data
where configured. The separate placement role remains a policy proposal; the
current navigation and authorization use the existing roles.

### Student security guarantees

The student module intentionally enforces the following:

- Student identity comes from the authenticated session.
- Query parameters cannot select another student's rows.
- SQL values are parameterized.
- Invalid IDs and pagination values return explicit errors.
- Hall-ticket eligibility is checked in a transaction.
- Database foreign keys and constraints provide a second line of defense.
- Sensitive credentials are not embedded in source documentation.

## 9. Faculty module

Faculty users have a separate dashboard and can access:

- Dashboard and notices.
- Assigned classes.
- Attendance entry.
- Examination marks entry.
- Leave management.
- Payslips and salary information.
- Profile and grievances.
- Placement reporting for eligible HOD users.

### Faculty attendance

Faculty attendance is scoped to the logged-in faculty member's teaching
assignments. Faculty can select an assignment and session, record attendance,
and save changes.

Attendance controls include:

- Regular session date and timetable validation.
- Extra sessions with a required reason.
- Weekend policy handling.
- A 14-day edit lock.
- Session-specific unlock requests for older sessions.
- Admin approval or rejection with a 48-hour expiry.
- Audit entries containing the actor, old values, new values, and request ID.

### Faculty examination

Faculty examination marks entry is available at `/faculty/examination`.

The workflow:

1. Lists the faculty's permitted current-session courses.
2. Selects a non-completed exam cycle.
3. Shows only components applicable to the course type.
4. Validates marks against component maxima.
5. Rejects invalid combinations such as laboratory mid-semester marks.
6. Saves marks, course results, semester results, and CGPA-related data in one
   transaction.

Course-type schemes include:

- **TH**: internal 20, mid-semester 20, end-semester 60.
- **LAB**: internal 50, practical/end-semester 50, no mid-semester component.
- **TUT**: existing applicable scheme.

## 10. Admin and academic office module

Admins can manage or inspect:

- Dashboard and inbox.
- Departments.
- Programs and curricula.
- Course catalog.
- Academic sessions.
- Divisions and sections.
- Electives.
- Students.
- Faculty.
- Faculty leave.
- Faculty payroll.
- Attendance unlock requests.
- Notices.
- Grievances.
- Placement.
- Shared UI kit.
- Audit log.

Admin-only attendance decisions are role-checked both at the route and query
layers. The audit area helps trace who changed important records and when.

## 11. Attendance subsystem

Core attendance entities include:

- `attendance_session`
- `attendance_summary`
- `attendance_correction`
- `attendance_unlock_request`
- `attendance_session_audit`

Important views include:

- `v_assignment_roster`
- `v_attendance_record`
- `v_student_attendance_overall`
- `v_student_attendance_by_course`

An attendance session stores absent student IDs compactly. Database triggers
refresh `attendance_summary`, which is then consumed by the student dashboard,
student attendance APIs, examination eligibility, and shortage notifications.

## 12. Examination subsystem

Examination entities include:

- `grade_scale`
- `course_exam_scheme`
- `exam_cycle`
- `exam_schedule`
- `exam_registration`
- `hall_ticket`
- `exam_marks`
- `course_result`
- `semester_result`
- `student_cgpa`

Important views and functions include:

- `v_student_result_sheet`
- `v_student_exam_timetable`
- `v_faculty_marks_entry`
- `v_attendance_defaulters_by_division`
- `v_student_cgpa_rank`
- `refresh_exam_results()`
- `calculate_cgpa(student_id)`

## 13. Finance subsystem

The finance schema additions include:

- `fee_record`
- `fee_payment`
- `wallet`
- `wallet_txn`
- `fee_receipt_seq`
- `v_fee_receipt`

The finance rules calculate totals and outstanding balances, prevent negative or
overpaid values, verify payment ownership and amount, assign receipts, and keep
wallet balance and ledger changes together.

The application must verify a payment signature or webhook before calling the
database payment-application function.

## 14. Communication, grievances, and placement

### Notices

Notices are shared across roles with audience and publication filtering. They are
available from each role's navigation where applicable.

### Grievances

The grievance workflow is shared by students, faculty, and administrators.
Authenticated users submit records under their own identity, while authorized
staff handle them.

### Placement

Placement pages support student opportunities and administrative/faculty
reporting. The database and routes use the currently approved role model; a
separate placement role is not enabled by default.

## 15. Testing and verification

Useful commands:

```powershell
npm test
npm run typecheck
npm run build
```

Focused examples:

```powershell
npm test -- tests/app/student-pages.test.ts tests/app/student-api.test.ts
npm test -- tests/unit/attendance-unlock.test.ts tests/app/faculty-attendance.test.ts tests/app/portal.test.ts
npm test -- tests/unit/faculty-examination-marks.test.ts tests/db/group3-examination.test.ts tests/app/faculty-examination.test.ts tests/app/student-api.test.ts
```

Database-dependent tests require a configured PostgreSQL database, migrated
schema, loaded data, and suitable demo accounts. Unit tests that do not access
the database can run independently.

The CI workflow runs installation, TypeScript checks, and database-independent
unit tests on pushes and pull requests.

## 16. Local development workflow

### Quick setup

Use the shared configured database:

```powershell
npm install
npm run dev
```

### Full local setup

For schema, data-pipeline, and database work:

1. Install Node.js, Python, and Docker Desktop.
2. Put the required raw group CSV files in the project root.
3. Start PostgreSQL in Docker.
4. Create `.env` from `.env.example`.
5. Run the data build and user-generation commands.
6. Run migrations, loading, and verification.
7. Start the portal and run tests.

See [SETUP.md](SETUP.md) for the exact Windows PowerShell commands and environment
configuration.

## 17. Environment and security notes

Required application configuration includes:

- `APP_DATABASE_URL`
- `SESSION_SECRET` with at least 32 characters
- `DATABASE_SSL` as appropriate for the environment
- `PORT`

Local database loading may also use:

- `DATABASE_URL`
- `APP_DB_PASSWORD`
- `DEMO_PASSWORD`
- `ADMIN_PASSWORD`

Do not copy real values for these variables into documentation or source control.
Use `.env`, private team communication, or the project secret manager.

## 18. Current implementation status and known gaps

The main attendance, examination, student API, student page, faculty marks-entry,
and fees/D-Wallet work is implemented in this checkout.

Known limitations and intentionally unimplemented areas include:

- Certificate request, approval, verifiable PDF, and digital certificate wallet
  workflows are not present.
- Examination timetable/results publication is not currently an independent
  notification event.
- Production Supabase/Vercel checks require the appropriate external credentials
  and are not proven by local tests.
- The separate placement role is still a proposal; placement uses existing roles.
- Some source attendance and faculty records were withheld during data integration
  where required identity mappings were unavailable.
- Generated datasets and local credentials are development artifacts and must not
  be treated as official institutional records.

## 19. Useful documentation

- [README.MD](README.MD) - concise project overview and quick links.
- [SETUP.md](SETUP.md) - Windows setup, Docker, database loading, and troubleshooting.
- [docs/modules/student-experience.md](docs/modules/student-experience.md) - student
  data rules and acceptance notes.
- [docs/modules/attendance.md](docs/modules/attendance.md) - attendance data model,
  rules, and demonstration.
- [docs/modules/examination.md](docs/modules/examination.md) - examination entities,
  eligibility, marks, and results.
- [docs/modules/fees.md](docs/modules/fees.md) - fee, payment, receipt, and wallet rules.
- [docs/modules/platform.md](docs/modules/platform.md) - shared platform, CI, and release notes.
- [docs/evaluation-demo.md](docs/evaluation-demo.md) - cross-role demonstration workflow.
- [docs/work-assignments.md](docs/work-assignments.md) - module ownership and planned work.

## 20. Summary

PICT Student ERP Portal is a full-stack academic ERP demonstration centered on a
strong PostgreSQL data model and a role-aware web portal. Its most important
student capability is the secure, database-backed academic self-service flow:
students can inspect their own profile, curriculum, courses, attendance, exams,
hall-ticket eligibility, marks, results, fees, notices, grievances, and placement
information from one place.

The project emphasizes database correctness as much as UI functionality.
Attendance and examination eligibility are calculated from relational data and
database rules, marks and results are bounded by course schemes, fees are
transactional and idempotent, and sensitive student data is scoped to the
authenticated identity.
