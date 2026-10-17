# Roadmap: work divided by phase

Each phase is a self-contained package of work that ends in a working, deployable portal. Phases
build on each other in order (P2 → P6). Inside a phase, the numbered work items can be split
between team members: write your name in **Owner** when you pick one up.

**How we work on a phase**
1. Create a branch: `git switch -c p2-attendance-marking` (one branch per work item is fine too).
2. Database changes go in a **new** numbered file in `migrations/` (never edit an applied one).
3. Write tests alongside the feature (`tests/db` for rules, `tests/app` for pages).
4. `npm run typecheck` and `npm test` must pass, then open a pull request into `main`.
5. After merging: `npm run supabase:migrate` (and a data load if the phase adds seed data), then `npx vercel deploy --prod`.

Rules already decided in the approved specification are repeated under each phase, so nobody has to invent policy.

---

## ✅ P0 · Unified database and data pipeline (done)
- PostgreSQL schema for G2 academic structure, G1 students, generated faculty, G3 sections & attendance (`migrations/001`–`006`).
- Python pipeline (`scripts/data/`): student cleanup, curriculum-based enrollment, faculty sizing, clash-free timetable, attendance regenerated to match the G2 curriculum. Every change is listed in `data/reports/data-cleanup-report.md`.
- Bulk loader, 9 integrity checks, 14 database-rule tests.

## ✅ P1 · Accounts, layout, dashboards, academic structure, profiles (done)
- Accounts for every student/faculty + admin; scrypt hashes; sessions stored in PostgreSQL; CSRF protection; lockout after 5 failed attempts; forced password change at first sign-in; `audit_log` (`migrations/007`, `008`).
- Student: dashboard, curriculum, profile (own contact details editable).
- Faculty: dashboard, classes, class roster, view of their own students only.
- Admin: dashboard, departments, programs & curriculum, course catalog & prerequisites, sessions, divisions & honors sections, students, faculty, account actions, audit log.
- Deployed: Supabase (Tokyo) + Vercel; least-privilege `erp_app` role; 48 tests.

---

## ⏳ P2 · Timetable, attendance marking, attendance corrections
**Decided rules:** statuses are Present/Absent only · every change to a submitted session needs **Admin approval** · minimum attendance 75% (per-course `min_attendance_pct`) · a shortage is *flagged only*, nobody is automatically barred from exams.

| # | Work item | Owner |
|---|---|---|
| 2.1 | **Timetable pages**: weekly grid for students (division + batch + honors), faculty (own classes) and admin (by division / faculty / room). Data already exists in `timetable_entry` / `v_timetable`. | |
| 2.2 | **Mark attendance (faculty)**: open today's session from the timetable, roster with all students present by default, tick the absentees, submit → `INSERT attendance_session` (the trigger validates the roster and updates `attendance_summary`). Allow marking a cancelled session. One session per assignment per date (already a unique key). | |
| 2.3 | **Session records**: faculty list of their past sessions with present/absent counts (`v_faculty_session_sheet`); student attendance detail page per course (date-by-date list from `v_attendance_record`). | |
| 2.4 | **Corrections**: faculty request (`attendance_correction`: session, student, from→to, reason); admin queue to approve/reject; **new migration** with a procedure `approve_attendance_correction(correction_id, admin_user_id, note)` that updates the absent array, sets the request status, writes `audit_log` in the same transaction. Faculty "Correction history" page. | |
| 2.5 | **Low-attendance lists**: faculty "below minimum" view across their classes; admin shortage report by department/division with CSV export. | |
| 2.6 | **Tests**: marking (roster validation, duplicate date rejected, summary updated), correction approval/rejection (audit row, summary changes), permissions (faculty can mark only their own assignment; students read-only). | |

**Done when:** a faculty member marks a session on the live site, the student sees the new percentage immediately, and a correction goes request → admin approval → updated percentage + audit entry.

---

## P3 · Examinations, results, syllabus coverage
**Decided rules:** every course is marked **in-sem 20 + internal 20 + end-sem 60 = 100** · pass = **total ≥ 40 and end-sem ≥ 24/60** · grades:

| Total | 90–100 | 80–89 | 70–79 | 60–69 | 50–59 | 45–49 | 40–44 | < 40 or end-sem < 24 | absent in end-sem |
|---|---|---|---|---|---|---|---|---|---|
| Grade | O | A+ | A | B+ | B | C | P | F | AB |
| Points | 10 | 9 | 8 | 7 | 6 | 5 | 4 | 0 | 0 |

SGPA = Σ(credits × points) / Σ registered credits of the semester · CGPA the same over all semesters, an F counting 0 until cleared and the passing attempt replacing it · F/AB = back subject, cleared by a supplementary end-sem (in-sem and internal carried over, attempt number stored). Results are labelled "demo grading rules".

| # | Work item | Owner |
|---|---|---|
| 3.1 | **Schema** (new migration): `grade_scale`, `course_result` (one row per attempt), `semester_result`, `result_publication` (per course/term: Draft → Locked → Published); FK `course_prerequisite.min_grade` → `grade_scale`. | |
| 3.2 | **Grading in the database**: function `grade_for(total, end_sem, absent)`; procedure `publish_results(course, session)` computing grades, SGPA, CGPA; trigger blocking mark edits once locked. | |
| 3.3 | **History generation** (`scripts/data`): marks for every completed semester of active and graduated students (lateral entry starts at semester 3; open-elective choice for semester 6), including some backlogs. Keep within the 500 MB budget (`db:verify` prints the size). | |
| 3.4 | **Marks entry (faculty)**: spreadsheet-like form per class; in-sem pre-filled for the current term; validation 0–20/0–20/0–60. | |
| 3.5 | **Admin**: lock & publish per course, supplementary exam entry, results overview by department. **Student**: results by semester, SGPA/CGPA, back subjects. | |
| 3.6 | **Syllabus coverage**: `course_unit` (5 units per course with planned lectures; unit titles written per course) and `syllabus_coverage` (session → unit); faculty tag the unit while marking attendance (P2 form); student "syllabus covered" bars (already on the mockup). | |
| 3.7 | **Tests**: grade boundaries (39/40, 23/24 end-sem, AB), SGPA/CGPA known cases, publish/lock workflow, permissions. | |

**Done when:** published results show correct SGPA/CGPA for hand-checked cases and back subjects appear on the student dashboard.

---

## P4 · Fees, certificates, document wallet
**Decided rules:** fee structure per category from the fee CSV · **2 installments: 50% due 15 Aug, 50% due 15 Jan** · late fee **₹500 if > 30 days overdue, ₹1,500 if > 90 days** · only *Active* students get 2026-27 demands · the Admin records payments → numbered receipt · certificates: **Bonafide, Grade card / transcript, Fee receipt / No-dues, Leaving certificate**, each issued after Admin approval · **D-Wallet = digital document wallet** (PDFs generated on download, not stored).

| # | Work item | Owner |
|---|---|---|
| 4.1 | **Schema**: `fee_structure`, `fee_demand`, `fee_installment`, `fee_payment` (receipt number sequence); balance view; late-fee function. Import the fee CSV as opening balances. | |
| 4.2 | **Admin fees**: record payment (transaction + audit), outstanding list with filters, collection report by department/category. **Student**: dues, installments, payment history. | |
| 4.3 | **PDF generation** with `pdfkit` (works on Vercel): receipt, bonafide, grade card/transcript (uses P3 results), no-dues, leaving certificate. | |
| 4.4 | **Certificate requests**: `certificate_request` workflow (Requested → Approved/Rejected → Issued); admin queue; student D-Wallet page listing issued documents and receipts. | |
| 4.5 | **Tests**: installment/late-fee arithmetic, payment → balance, no-dues only when balance is 0, permissions (students see only their own documents). | |

---

## P5 · Notices, grievances, faculty leave, payroll
**Decided rules:** leave quotas **CL 12 / EL 15 / ML 10 per year + loss of pay (LOP)**, applied by faculty and approved by the Admin · payroll (labelled demo): basic **Professor ₹90,000 / Associate ₹70,000 / Assistant ₹50,000**, **DA 50% and HRA 10% of basic, PF 12% of basic, professional tax ₹200**, LOP deduction = gross ÷ days in month × LOP days · payroll run Draft → Final → Paid; seed Jul–Sep 2026 paid, Oct draft · notices in the portal only (no e-mail/SMS).

| # | Work item | Owner |
|---|---|---|
| 5.1 | **Notices**: `notice` + `notice_target` (all / role / department / year / division). Admin posts anywhere; faculty only to divisions they teach. Shown on dashboards (replaces the mockup placeholders). | |
| 5.2 | **Grievances**: categories Academic / Attendance / Fees / Exam / Facilities / Other; statuses Open → In progress → Resolved / Rejected; comment thread; students and faculty submit, the Admin responds. | |
| 5.3 | **Leave**: `leave_type`, `leave_balance`, `leave_request`; balance computed; overlapping requests rejected by the database; approved LOP days feed payroll. | |
| 5.4 | **Payroll**: `salary_structure`, `payroll_run`, `payslip`; procedure that generates a month's payslips; payslip PDF. | |
| 5.5 | **In-app notifications**: shortage, results published, request status changes (bell in the top bar). | |
| 5.6 | **Tests** for each workflow and its permissions. | |

---

## P6 · Final testing, hardening, submission material
| # | Work item | Owner |
|---|---|---|
| 6.1 | Full regression run on the live site with every role; fix slow pages (keep queries under the 15 s `erp_app` statement timeout; avoid per-row aggregates over views). | |
| 6.2 | Security pass: permission review per route, rate limits, `npm audit`, dependency updates. | |
| 6.3 | Report material: ER diagram, table list with keys, showcase of triggers/procedures/views/exclusion constraints with sample queries, the compact attendance storage decision. | |
| 6.4 | Demo script for the evaluation (which account shows which feature) and a final check that Supabase is not paused. | |
