# Grievances (T8-2)

Students and faculty raise grievances with the academic office and follow them to a decision.
The admin sees every grievance in one queue, can hand one to a faculty member, replies in a shared
comment trail, and closes it as **Resolved** (approved) or **Rejected**, always with a note.

Migration: `migrations/080-grievances.sql` · Seed: `scripts/db/seed-grievances.ts` ·
Routes: `src/routes/grievance-routes.ts` (student + faculty), `src/routes/admin/grievance-routes.ts` ·
Queries: `src/queries/grievance-queries.ts` · Tests: `tests/db/grievance.test.ts`, `tests/app/grievance.test.ts`

## Workflow

```
            assign / pick up              resolve (note)
  Open ─────────────────────▶ In progress ─────────────▶ Resolved
    │                              │      reject (note)
    └──────── resolve / reject ────┴───────────────────▶ Rejected     (closed = frozen)
```

- Categories: Academic, Attendance, Fees, Exam, Facilities, Other.
- Who can read and reply: the person who raised it, the faculty member it is assigned to, and the admin.
- Only the admin assigns, moves it to In progress, and closes it.
- What the raiser wrote cannot be edited. A closed grievance cannot change and takes no more replies.

## Tables

| Table | Key | Purpose |
|---|---|---|
| `grievance` | `grievance_id` | One grievance: raiser (`raised_by` + `raised_by_role`), category, subject, description, status, assignee, resolution note, the admin who closed it, timestamps |
| `grievance_comment` | `comment_id` | The comment trail (FK `grievance`, `author_id` → `app_user`) |
| `grievance_status_log` | `log_id` | Every status change: from, to, who, when (written only by a trigger) |

Types: `grievance_category`, `grievance_status`. The migration also adds `UNIQUE (user_id, role)` on
`app_user` so the composite FK `(raised_by, raised_by_role) → app_user (user_id, role)` can prove the
stored role is the account's real role.

## Rules and where they are enforced

| Rule | Where |
|---|---|
| Only students and faculty raise grievances; the stored role matches the account | `CHECK raised_by_role IN (...)` + composite FK |
| Subject ≥ 5 characters, description 10–4,000, comment 1–2,000 | `CHECK`s (and zod in the routes) |
| New grievances start Open, unassigned, unresolved | trigger `new_grievance` |
| Allowed transitions only (no going back, nothing after closing) | trigger `workflow` |
| Raiser, subject and description are immutable | trigger `workflow` |
| Assigning stamps `assigned_at` and moves Open → In progress; only active faculty; never the raiser | trigger `workflow` |
| Closing stamps `resolved_at`/`resolved_by`; only an admin can close | trigger `workflow` + `CHECK (closed ⇔ resolved_at)` |
| A closed grievance has a note of ≥ 5 characters | `CHECK` |
| `resolved_at ≥ created_at`; `assigned_to` and `assigned_at` set together | `CHECK`s |
| Every status change is logged with who did it | trigger `log_status` (actor from `set_config('erp.user_id', …)`) |
| Only participants comment, only while open | trigger `participant_only` using `grievance_participant()` |
| Only the participants can open a grievance page; everyone else gets a 404 | `getGrievanceFor()` uses `grievance_participant()` |
| Every write runs in a transaction and adds an `audit_log` row (`GRIEVANCE_*`) | routes |

## Views, functions and procedures

**`v_grievance_overview`**: one row per grievance with the raiser's name, login and department, the assignee, the comment count and the age in days.
```sql
SELECT grievance_id, subject, status, raised_by_name, assigned_name, age_days
FROM erp.v_grievance_overview WHERE status IN ('Open', 'In progress') ORDER BY created_at;
```

**`v_grievance_resolution_stats`**: per category (every category, even unused): open, in progress, resolved and rejected counts, average days to resolve, average days to close, and the oldest open grievance.
```sql
SELECT category, total, resolved, avg_days_to_resolve FROM erp.v_grievance_resolution_stats;
```

**`grievance_participant(user_id, grievance_id) → boolean`**: may this account see and reply to this grievance?
```sql
SELECT erp.grievance_participant(42, 7);
```

**`CALL assign_grievance(grievance_id, faculty_id | NULL, admin_user_id)`**: assign (or unassign) a faculty member.
```sql
CALL erp.assign_grievance(7, 1074, 1);
```

**`CALL resolve_grievance(grievance_id, admin_user_id, 'Resolved' | 'Rejected', note)`**: close it with a note.
```sql
CALL erp.resolve_grievance(7, 1, 'Resolved', 'Projector replaced on 21 Oct.');
```

**`acting_user_id()`**: the user the app set for this transaction with `set_config('erp.user_id', …, true)`.

## Pages

| Who | URL | What |
|---|---|---|
| Student | `/student/grievances`, `/new`, `/:id` | my grievances, raise one, detail + replies |
| Faculty | `/faculty/grievances`, `/new`, `/:id` | **Assigned to me** + raised by me, raise one, detail + replies |
| Admin | `/admin/grievances` | queue (default Open + In progress) with status/category/role/search filters, totals, per-category stats |
| Admin | `/admin/grievances/:id` | detail, replies, **Resolve / Reject** with a note, assign by faculty code (suggestions from the raiser's department, HOD first), mark In progress |

## Seed data

`npm run db:seed-grievances` (local) or `npm run supabase:seed-grievances` adds about 240 deterministic
grievances from Jul 2026 to today with replies, assignments and outcomes (~430 kB). It runs only when
`grievance` is empty, so real grievances are never touched. Re-run it after `npm run db:load`
(the load truncates grievances together with the accounts).

## Demo script (3 minutes)

1. Sign in as **STU202600004** → *Grievances* → **Raise a grievance** (Facilities, "Projector broken in A-101").
2. Sign in as **admin** → *Grievances*: the new grievance is at the top of the queue as **Open**.
   Open it, assign **FAC-CSE-074** (it moves to **In progress**), and post a reply.
3. Sign in as **FAC-CSE-074** → *Grievances* → **Assigned to me** → open it and reply.
4. Back as **admin**: write a note and click **Resolve** (or **Reject**). The grievance is closed and frozen.
5. As **STU202600004**: the detail page shows the whole trail, the status changes and the outcome note.
   Replying is no longer possible. *Audit log* shows every `GRIEVANCE_*` action.
