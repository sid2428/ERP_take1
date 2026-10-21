# Notices and in-app notifications (T8-3)

T8 combines an audience-targeted announcement system with dedicated personal notifications and
live status alerts. Students, faculty, and admins see a role-specific bell in the authenticated top
bar. The bell links to `/student/notices`, `/faculty/notices`, or `/admin/inbox` and shows the
current user's unread count across announcements and dedicated notifications.

Migration: `migrations/081-notices.sql`, `migrations/082-automatic-notices.sql`, and
`migrations/083-notifications.sql` · Seed: `scripts/db/seed-notices.ts` · Routes:
`src/routes/notice-routes.ts`,
`src/routes/admin/notice-routes.ts` · Queries: `src/queries/notice-queries.ts` · Tests:
`tests/db/notice.test.ts`, `tests/db/automatic-notice.test.ts`, `tests/app/notice.test.ts`

## Audiences and stored data

A notice has one or more targets. A target narrows the audience with optional filters, and a notice
reaches a person when any target matches them:

| Target | Reaches |
|---|---|
| `{}` | everyone |
| `{role}` | every active account with that role |
| `{dept_id}` or `{dept_id, role}` | matching department accounts |
| `{year_of_study}` with optional `{dept_id}` | matching students in the current session |
| `{division_id}` | students in that current-session division |
| `{user_id}` | exactly one active account; personal notice only |

| Table | Key | Purpose |
|---|---|---|
| `notice` | `notice_id` primary key | title, body, category, importance, poster, expiry, withdrawal, optional internal link and source |
| `notice_target` | `target_id` primary key | audience filters or one personal `user_id` |
| `notice_read` | composite primary key `(user_id, notice_id)` | read timestamp |
| `notification` | `notification_id` primary key | one recipient's personal event message, kind, text, internal link, timestamps and read state |

`v_user_audience` resolves active accounts to role, department, year, and division. The
`v_user_notices` view combines live announcements with unexpired dedicated notifications and joins
each user's read state. Its appended `item_type`, `notification_id`, and `notification_kind` columns
are the discriminator; routes never infer the record type from a numeric ID. Announcement rows with
only personal targets are backfilled into `notification` and omitted from the combined view, while
mixed group/personal notices remain in `notice` so no group recipient is lost.

## Rules and enforcement

The database enforces posting permissions, faculty teaching-division restrictions, target validity,
at-least-one-audience, immutable posted notices, final withdrawal, expiry constraints, valid
notification recipients/messages/links, and recipient-only read tracking. Route forms also validate
fields with Zod. Portal writes run in a transaction and add the relevant `NOTICE_*` audit record;
database-triggered grievance notifications remain atomic with the grievance transaction.

The database objects responsible for these rules are:

| Object | Definition and responsibility |
|---|---|
| `guard` | `BEFORE INSERT OR UPDATE` on `notice`, calling `trg_notice_guard()`. Only active admin/faculty posters or `NULL` system posters are accepted; posted content is immutable; withdrawal is final and restricted to the poster or an admin. Migration 082 also freezes `link` and `source`. |
| `audience_guard` | `BEFORE INSERT OR UPDATE OR DELETE` on `notice_target`, calling `trg_notice_target_guard()`. It fills student role for year/division targets, rejects invalid target changes, and limits faculty posters to divisions they teach in the current session. Cascading deletion of targets during notice deletion is allowed. |
| `has_audience` | Deferred `AFTER INSERT` constraint trigger on `notice`, calling `trg_notice_has_target()`. The posting transaction must commit with at least one target. |
| `recipient_only` | `BEFORE INSERT` on `notice_read`, calling `trg_notice_read_guard()`. The target must match the recipient's `v_user_audience` row, including personal `user_id` targets. |

The key views and matching function are:

* `v_user_audience` returns `(user_id, role, dept_id, year_of_study, division_id)` for every active
  account. Student year/division values come from the current-session section; faculty department
  values come from the faculty record.
* `v_user_notices` returns live, recipient-filtered notices with read state. Migration 082 adds
  `link`, `source`, and `is_personal`; migration 083 appends `item_type`, `notification_id`, and
  `notification_kind` and unions in dedicated notifications. A personal announcement row is
  identified when the notice has a personal `user_id` target.
* `v_notice_reach` returns `(notice_id, recipients, reads)`. Group targets are counted from grouped
  audience rows; personal targets add only named people not already covered by a group target.
* `notice_target_matches(t notice_target, a v_user_audience) -> boolean` matches optional role,
  department, year, division, and (in migration 082) personal `user_id` constraints.

Representative read-only examples use bound parameters rather than interpolated IDs:

```sql
SELECT notice_id, recipients, reads
FROM erp.v_notice_reach
WHERE notice_id = $1;

SELECT erp.notice_target_matches(t, a) AS matches
FROM erp.notice_target AS t
JOIN erp.v_user_audience AS a ON a.user_id = $1
WHERE t.notice_id = $2;
```

`notice_read` is only for `notice` rows. Dedicated notifications store `read_at` on their own row,
with one row per recipient. `user_alerts(user_id)` returns live attendance/fee status alerts and
does not create read rows; an alert disappears when its underlying condition is fixed.

## Current functions and query contracts

Migrations 081–083 create the database contracts below. The portal and other modules call them with
bound parameters.

`v_user_notices(user_id)` is the read-state and recipient contract:

```sql
SELECT notice_id, title, category, is_personal, is_read
FROM erp.v_user_notices
WHERE user_id = $1
ORDER BY is_important DESC, posted_at DESC;
```

`post_notice(posted_by, title, body, category, targets jsonb, is_important = false,
expires_at = NULL, link = NULL, source = NULL) -> notice_id` creates an audience-targeted notice.
`posted_by = NULL` is used for system notices. `link` must be an internal portal path and `source`,
when present, is one of `grievance`, `exam`, `results`, `fees`, or `attendance`.

```sql
-- Prepared-statement shape; bind real, validated values in the caller.
SELECT erp.post_notice($1, $2, $3, $4::erp.notice_category, $5::jsonb, $6, $7, $8, $9);
```

Callers must bind the correct existing poster/user IDs, department IDs, year values, categories, and
safe internal links. For example, a T5 caller may bind a current-session target JSON value such as
`[{"role":"student","dept_id":"CSE","year_of_study":3}]` only after resolving that audience;
the example is not a production-ready ID fixture.

`notify(user_id, kind, text, link)` is the assignment-compliant procedure. It is a no-op for a
missing or inactive recipient, rejects invalid message data and external links, and stores a
notification atomically with a 60-day expiry. The five-argument overload additionally accepts a
`notice_category` so grievance events retain the existing category filters.

```sql
-- The required four-argument contract; bind an active app_user ID and a validated internal path.
CALL erp.notify($1, $2, $3, $4);

-- T8 grievance trigger form, retaining the category used by the existing board filters.
CALL erp.notify($1, $2, $3, $4, $5::erp.notice_category);
```

The `notification` table also keeps a display title, category, optional poster, expiry, and
`legacy_notice_id` solely to preserve the existing UI and historical personal notices. Its primary
key is `notification_id`; `user_id` is the recipient foreign key. A partial unread index supports
the bell count, and the internal-link check accepts only portal paths beginning with `/`.

`notify_user(user_id, title, body, category, link = NULL, source = NULL) -> notification_id` is a
backward-compatible adapter for verified old callers. It now writes `notification`, preserves the
old title/body/category/source/expiry behavior, and returns the dedicated notification ID. New
grievance triggers call `notify(...)` directly.

```sql
-- Bind an existing active app_user ID and a validated internal path, or NULL for no action.
SELECT erp.notify_user($1, $2, $3, $4::erp.notice_category, $5, $6);
```

`user_alerts(p_user_id int) RETURNS TABLE (kind text, severity text, title text, body text, link text)`
calculates current live alerts for an active student. Attendance uses
`v_student_attendance_by_course`; fees are enabled conditionally when `v_student_fee_status` exists.

`post_exam_timetable_notice(p_title text, p_body text, p_dept_id varchar = NULL,
p_year smallint = NULL, p_until timestamptz = NULL) RETURNS int` and
`post_results_notice(p_title text, p_body text, p_dept_id varchar = NULL,
p_year smallint = NULL) RETURNS int` are T5 helper functions. They create important targeted Exam
notices:

```sql
SELECT erp.post_exam_timetable_notice($1, $2, $3, $4::smallint, $5);
SELECT erp.post_results_notice($1, $2, $3, $4::smallint);
```

The repository currently defines these helpers but has no verified T5 publication caller. T5 should
call them from its real publication workflow when that workflow exists.

The application query `unreadNoticeCount(userId)` counts `NOT is_read` from `v_user_notices` for
one signed-in user. The app loads it once as a shared authenticated view local. It therefore respects
recipient, withdrawal, expiry, and read rules without materializing other users' notices.

## User experience and routes

| Who | URL | Behaviour |
|---|---|---|
| Student | `/student/notices`, `/:id`, `/notification/:id`, `/notification/:id/go` | announcements/personal filter, category filter, read state, mark-all-read, safe personal navigation |
| Faculty | `/faculty/notices`, `/new`, `/:id`, `/notification/:id`, `/notification/:id/go` | same inbox plus Posted by me, taught-division posting and withdrawal |
| Admin | `/admin/inbox`, `/:id`, `/notification/:id`, `/notification/:id/go` | current user's inbox and personal alerts; bell destination |
| Admin | `/admin/notices`, `/new`, `/:id` | announcement management, reach/read counts, state/category/kind filters, withdrawal |

The shared board accepts `kind=all`, `kind=announcements`, or `kind=personal` and a `category`
parameter. Switching either filter preserves the other. Mark-all-read applies to the selected kind
and category and never writes another user's rows. Opening a permitted notice marks it read; `/go`
then redirects to its stored internal link. Dedicated notification IDs use the explicit
`/notification/:id` route; legacy numeric notice URLs remain supported. Guessed IDs are checked
through the combined view and return 404 for non-recipients. A notification without a link opens
its accessible detail page instead.

## Grievance notification events

Migration 083 redefines these database-triggered events; all use `notify(...)`, kind `grievance`,
and commit atomically with the grievance change:

| Trigger/event | Recipients | Stored link and detail |
|---|---|---|
| `notify_new` after grievance creation | Every active admin | `/admin/grievances/:id`; includes the raiser and category in the message |
| `notify_change` after assignment to a different faculty member | The assigned faculty member and the grievance raiser | Faculty and raiser role-specific grievance paths; the raiser receives “being handled” |
| `notify_change` when status changes `Open` -> `In progress` without the assignment branch | The grievance raiser | Raiser role-specific grievance path |
| `notify_reply` after a comment | Every other participant: the raiser, assigned faculty account, and active admins; the comment author is excluded | Each recipient's role-specific grievance path; message includes the comment author and truncated body |
| `notify_change` when status first becomes `Resolved` or `Rejected` | The grievance raiser and, when present, the assigned faculty member | Role-specific grievance path; the raiser receives the resolution note and the assignee receives a closed notice |

The assignment branch is evaluated before the standalone `Open` -> `In progress` branch. A later
update that changes only status produces the standalone transition notice. The closure trigger covers
both resolution and rejection, with the status text reflected in each message.

## Cross-module integration matrix

| Source | Event | Current implementation | Next step |
|---|---|---|---|
| T4 Attendance | student falls below required attendance | Implemented live alert through `user_alerts(user_id)` using `v_student_attendance_by_course`; called by the notice board/dashboard. No T4 event caller to `notify(...)` exists. | Decide whether the live alert satisfies the shared notification requirement before adding a stored event |
| T5 Examinations | timetable/results published | `post_exam_timetable_notice(...)` and `post_results_notice(...)` helpers exist | Verify the real publication workflow calls the relevant helper |
| T6 Fees | fee pending/overdue | Optional live alert reads `v_student_fee_status` when that view exists; no current T6 view definition or stored-notification caller was found | Verify compatibility with the real T6 view and fee screen |
| T1 Student | request/certificate decision | No caller found in the repository | Coordinate when the event/API exists |
| T2 Faculty | leave/request decision | No caller found in the repository | Coordinate when the event/API exists |
| T7 Placement | new drive published | No caller found in the repository | Coordinate when the event/API exists |
| T8 Grievances | creation, assignment, reply, resolution/rejection | Implemented by database triggers redefined in `migrations/083-notifications.sql` through `notify(...)`; covered by T8 database/app tests | Preserve and extend when grievance events change |

## Architecture and migration compatibility

The assignment-compliant dedicated `notification` table and `notify(user_id, kind, text, link)`
procedure are implemented in migration 083 for T0 review. `notice` remains the announcement and
audience-targeting system; `notification` is one recipient per row for personal events. The combined
`v_user_notices` contract and explicit item discriminator let the existing bell, filters and routes
serve both without numeric-ID collisions.

Migration 083 backfills historical notices whose complete audience was personal, including their
title, body, link, timestamps and `notice_read` state. It does not delete old notice rows or read
rows. Mixed group/personal notices remain in `notice` to avoid losing group recipients. The old
`notify_user(...)` function remains as a safe compatibility adapter.

## Seed and demo

`npm run db:seed-notices` adds deterministic notice data only when `notice` is empty. Do not run
`npm run db:load` against the populated database; it reloads the dataset and related tables.

## Demo script

1. **Admin posting and reach:** sign in as an admin, open `/admin/notices/new`, choose **Division**,
   and enter a division code that exists in the current academic session. Post the notice, open its
   detail page, and review the audience plus recipient/read counts. Use the actual current-session
   code shown by the form; do not copy a stale or fictitious ID.
2. **Student read state:** sign in as `STU202600004` if that account is present in the selected
   division. Observe the bell and unread badge, open the notice, then reload the page and confirm the
   stored unread count has decreased. The board's Personal updates filter is separate from the
   announcement.
3. **Faculty permissions:** sign in as a faculty account, open `/faculty/notices/new`, and verify
   that only divisions the faculty member teaches are offered. Post to one offered division; a
   tampered request for another division is rejected by the database trigger.
4. **Withdrawal and audit:** as the admin, withdraw the posted notice from its detail page. Confirm
   it leaves the student board, then inspect the audit log for `NOTICE_POST` and `NOTICE_WITHDRAW`.
