# PICT Student ERP Portal

A unified college ERP built for our **DBMS course submission**. It brings the group modules
(G2 academic structure, G3 attendance, student and fee datasets) into **one PostgreSQL database**
and a working web portal for **students, faculty and the academic office**.

**Live demo:** https://pict-erp-portal.vercel.app
(login details: ask the team for `CREDENTIALS.md`. Passwords are never stored in this repo.)

> Academic project · synthetic data · not an official PICT system

---

## What work today

| Phase | Scope | Status |
|---|---|---|
| **P0** | Unified schema, data cleanup, curriculum-consistent attendance, bulk loader, integrity checks | ✅ Done |
| **P1** | Login & security, layout, student/faculty/admin dashboards, academic structure, profiles, deployment | ✅ Done |
| Next | Module teams in parallel: Student experience · Faculty & HR · Academic · Attendance · Examination · Fees · Placement · Communication | ⏳ In progress |

**Who does what:** [docs/work-assignments.md](docs/work-assignments.md) gives each module team its phases, tasks, expectations and start order. History of phases: [docs/roadmap.md](docs/roadmap.md).

### Database highlights (what the DBMS evaluation should look at)
- **24 tables, 10 views, 16 triggers and 12 functions/procedures** (after P1) in a dedicated `erp` schema, reached by a least-privilege role (`erp_app`) that can read and write data but cannot change the schema.
- **The database enforces the rules itself:**
  - exclusion constraints make timetable clashes impossible (room, faculty, division or batch);
  - a partial unique index allows exactly one current session;
  - a recursive-CTE trigger rejects prerequisite cycles;
  - an offering accepts no more students than its seat limit;
  - composite foreign keys require each batch to belong to its division;
  - attendance totals are kept up to date by triggers.
- **Compact attendance storage:** each session stores its absent students' IDs as an `int[]`. That keeps **3.5 million attendance marks in about 13 MB**, so the whole database is about 110 MB and fits Supabase's free 500 MB. The view `v_attendance_record` shows the same data as ordinary per-student rows.
- **Every change made through the portal is recorded** in `audit_log` (who, what, when, before and after).

## Tech stack
| Layer | Choice |
|---|---|
| Database | PostgreSQL 17 (Supabase free tier in production, Docker locally) |
| Server | Node.js 20+, Express 5, TypeScript (strict), plain parameterised SQL (`pg`) |
| Views | Server-rendered EJS + one CSS file ported from the group mockups |
| Hosting | Vercel (free Hobby plan) |
| Data pipeline | Python 3.11 + pandas |
| Tests | Vitest + Supertest |

## Getting started
- **Run it on your PC:** follow **[SETUP.md](SETUP.md)** step by step.
- **Deploy (Supabase + Vercel):** see [docs/deployment.md](docs/deployment.md).

## Repository layout
```
migrations/          numbered SQL migrations (schema, triggers, procedures, views)
scripts/data/        Python pipeline: cleans and integrates the group datasets
scripts/db/          migrate / load / verify / account and deployment helpers
src/                 Express app (routes, queries, middleware, auth)
views/               EJS pages per role (student, faculty, admin)
public/              CSS and the small client-side script
tests/               database-rule, unit and end-to-end HTTP tests
api/  vercel.json    Vercel entry point and configuration
data/reports/        data cleanup & generation report (every change to group data)
docs/                roadmap, deployment guide, original group reference material, mockups
```
The raw group CSVs (about 250 MB) are **not** in the repository. See SETUP.md for where they go.

## Group modules integrated
| Group | Module | Used for |
|---|---|---|
| G1 | Students | 50,000 student records (cleaned; see `data/reports/data-cleanup-report.md`) |
| G2 | Academic & Course | departments, programs, courses, prerequisites, curriculum (source of truth) |
| G3 | Attendance | divisions, batches, section mapping, attendance model (regenerated to match the curriculum) |
| — | Fees | fee snapshot (P4) |
| G6 | Faculty / HR / Payroll | dataset unavailable, so 430 faculty were generated |

Original material: [docs/reference](docs/reference) and [docs/mockups](docs/mockups).
