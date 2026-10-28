# Roadmap: work divided by phase

P0 and P1 are done. **All remaining work is organised by module team, each with its own phases.**
See **[work-assignments.md](work-assignments.md)**: who owns which module, the tasks, what is expected,
the contracts between teams and the start order.

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
- Deployed: Supabase (Tokyo) + Vercel; least-privilege `erp_app` role; 68 unit tests plus database and HTTP integration tests.

---

---

## Remaining phases → module teams
The original plan's phases P2–P6 are now split across the module teams in
[work-assignments.md](work-assignments.md):

| Original phase | Now handled by |
|---|---|
| P2 · timetable, attendance marking, corrections | **T4 Attendance** (T4-1 … T4-3), **T1** student timetable page (T1-2) |
| P3 · exams & results, syllabus coverage | **T5 Examination** (T5-1 … T5-3), **T3 Academic** syllabus coverage (T3-3) |
| P4 · fees, certificates, D-Wallet | **T6 Fees** (T6-1 … T6-3), **T1** certificates & D-Wallet (T1-3) |
| P5 · notices, grievances, leave, payroll | **T8 Communication** (T8-1 … T8-3), **T2 Faculty & HR** leave and payroll (T2-2, T2-3) |
| *(new)* placement | **T7 Placement** (T7-1 … T7-4) |
| *(new)* dashboard redesigns | **T1** student (T1-1), **T2** faculty (T2-1), with the shared UI kit from **T0** |
| P6 · testing, hardening, report | **T0 Platform** (T0-4) + every team's module doc and demo script |
