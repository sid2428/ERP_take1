# Notices and in-app notifications (T8-3)

T8 combines an audience-targeted announcement system with dedicated personal notifications and
live status alerts. Students, faculty, and admins see a role-specific bell in the authenticated top
bar. The bell links to `/student/notices`, `/faculty/notices`, or `/admin/inbox` and shows the
current user's unread count across announcements and dedicated notifications.

Migration: `migrations/080-grievances.sql`, `migrations/081-notices.sql`, `migrations/082-automatic-notices.sql`,
`migrations/083-notifications.sql`, `migrations/084-attendance-shortage-notifications.sql`, and
`migrations/092-notification-event-idempotency.sql`, `migrations/095-fee-payment-notifications.sql`,
and `migrations/096-faculty-leave-notifications.sql` ·
Seed: `scripts/db/seed-notices.ts` · Routes:
`src/routes/notice-routes.ts`,
`src/routes/notification-routes.ts`,
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

Migration 092 adds nullable event keys to notices and personal notifications. A key is an identity
provided by the authoritative producer, not a hash of message content. Unique indexes prevent a
publication from being created twice and prevent one recipient from receiving the same event twice.
Legacy rows and calls have `NULL` event keys and retain their existing behavior.

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

Migration 084 adds the `attendance_shortage_notification` trigger on `attendance_summary`. It
calls `notify(user_id, 'attendance_shortage', text, '/student', 'Academic')` only when an active
student’s current-session percentage crosses from eligible to below that course’s minimum. The
message includes the course code/name, updated percentage, minimum, and the existing
sessions-to-recover guidance when finite. It is update-only, so summary inserts and existing
rows do not notify; subsequent updates while still below minimum are also ignored. The trigger
preserves `user_alerts`, which remains the live aggregate alert.

## Current functions and query contracts

Migrations 081–084 create the database contracts below. The portal and other modules call them with
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

-- Event-keyed overload: reuse the key only for a retry of the same source event.
CALL erp.notify($1, $2, $3, $4, $5::erp.notice_category, $6);
```

Four- and five-argument calls delegate with a null key and remain compatible. Event-keyed calls use
a unique `(user_id, event_key)` index with `ON CONFLICT DO NOTHING`, so retries and concurrent calls
produce one row per recipient/event without deduplicating merely similar messages. `post_notice_once`
is the announcement counterpart: it serializes retries with a transaction advisory lock, returns the
existing notice ID, and creates a new notice plus targets atomically for a new event key.

The `notification` table also keeps a display title, category, optional poster, expiry, optional event key, and
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

The application query `notificationState(userId)` counts `NOT is_read` and fingerprints the visible
rows in `v_user_notices` for one signed-in user. The app loads it as a shared authenticated view
local. It therefore respects recipient, withdrawal, expiry, and read rules without materializing
other users' notices.

## Cross-device synchronization

The database remains authoritative. Authenticated pages render the initial count and a recipient-
scoped revision from `v_user_notices` and `user_alerts(user_id)`; the shared client then polls
`GET /api/notifications/state` every 15 seconds while visible and refreshes on focus or when a tab
becomes visible. The endpoint returns `{ unread, revision }`, sends `Cache-Control: no-store`, and
returns `401` without an active session. The revision includes the visible item identity, content
read state, and read timestamp, so a read on another device or a replacement event is detected even
when the unread total is unchanged. Live attendance/fee alert changes are included in the revision
even though they are not stored read-state rows. A visible notice board or dashboard notice card reloads
when its revision changes; other pages update only the bell badge and pick up the complete board on navigation.

Polling uses same-origin credentials, has no local notification cache, pauses in hidden tabs, and
allows only one request at a time. The existing role-specific routes and `v_user_notices` recipient
checks remain the authority for board contents, detail access, read writes, expiry, withdrawal, and
live `user_alerts`; the synchronization endpoint exposes no notice bodies or other users' data.

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

## Cross-module integration contracts

Event-keyed calls must execute in the same database transaction as the authoritative state change.
The producer supplies a stable key for retries and a different key for a distinct event. T8 validates
recipient activity, message fields, and internal links; it does not authorize upstream transitions
or decide eligibility. Invalid input aborts the surrounding transaction; unknown or inactive
recipients are ignored. The canonical prepared-statement shape is
`CALL erp.notify($1, $2, $3, $4, $5::erp.notice_category, $6)`.

| Team / event | Authoritative producer and payload | Recipient resolution | T8 interface, validation, transaction and idempotency | Tests and owner |
|---|---|---|---|---|
| T1 `certificate_request.decision` — report request outcome | The work assignment specifies `certificate_request` and `Requested → Approved/Rejected → Issued`, but this checkout has no schema/route. Payload adapter needs the request ID, student ID, resulting status, and stable transition key from that authoritative row. | T1 resolves active `app_user` via the request's student FK; T8 does not infer the student from client input. | Six-argument `notify`, category `Academic`, called only after a real transition in its transaction. Key combines request identity and transition identity. | T1 adds decision, recipient, and retry tests when its workflow lands; shared validation/retry tests are in `automatic-notice.test.ts`. Owner: T1. |
| T2 `faculty_leave_request.decision` — report approval or rejection | Existing `faculty_leave_request` and admin-only `/api/admin/hr/leave/requests/:reqId/{approve,reject}` routes call the T2 database procedures. Migration 096 observes the persisted `PENDING → APPROVED / REJECTED` transition. | Resolve the active faculty account from `NEW.faculty_id`; the API does not supply a recipient. | Six-argument `notify`, category `Academic`, in the same status-update transaction. Stable key `faculty-leave:<leave_request_id>:<outcome>`. Cancellation is not a decision event. | `tests/db/faculty-hr.test.ts` verifies recipient, message, event uniqueness and rollback atomicity; `tests/app/portal.test.ts` covers the non-admin 403 boundary. Owner: T2/T8. |
| T4 `attendance.shortage.entered` — persist an eligible-to-shortage edge | `attendance_summary` trigger uses the current-session row, course minimum and existing `last_updated`. Identity payload: `student_id int`, `course_id int`, `academic_session_id varchar(10)`, `last_updated timestamptz`. | Active student account joined from the summary's student ID; inactive students are excluded. | Six-argument `notify`, category `Academic`, key `attendance-shortage:<student>:<course>:<session>:<last_updated>`. Stored notification commits/rolls back with the summary update. Live `user_alerts` remains an aggregate of present conditions, not a stored/read event. | `automatic-notice.test.ts` covers live alert and notification contract; T4 owns summary semantics, T8 owns delivery. |
| T5 `exam.timetable.published` / `exam.results.published` — announce publication | `exam_cycle`, `exam_schedule`, and result tables exist, but this checkout has no publication state/caller. Producer payload includes `exam_cycle_id` and verified audience filters; saved marks/results alone are not publication. | Resolve the actual cycle audience from exam/curriculum data, then pass role/department/year targets. | Call `post_notice_once` with a stable publication event key, e.g. `exam-timetable:<cycle-id>:<publication-id>` or `exam-results:<cycle-id>:<publication-id>`. It applies existing notice audience/poster validation and runs in the publication transaction. Existing `post_exam_timetable_notice` and `post_results_notice` remain compatible but are not retry-idempotent. | `notice.test.ts` verifies one publication per event and unchanged first payload. `automatic-notice.test.ts` tests legacy helpers, not publication. Owner: T5 connects actual publication workflow. |
| T6 `fee.payment.succeeded` — confirm recorded payment; due/no-dues later | Migration 091 defines `fee_payment(payment_id int, student_id int, purpose, status)` and `apply_fee_payment(...)`; the payment API and verified webhook both use that function. Migration 095's status trigger derives payment and active recipient from the persisted row. | Resolve active student account from `fee_payment.student_id`, not a callback parameter. | Six-argument `notify`, category `Fees`, key `fee-payment:<payment_id>:succeeded`, inside the payment transaction after success. No due/no-dues notification is implemented without a real date/status contract. | `finance-payments.test.ts` verifies the recipient, stable event key, and one notification across retries. No due/no-dues event without a real date/status contract. Owner: T6/T8. |
| T7 `placement_drive.opened` — announce drive to eligible students | Existing admin route calls `notify_eligible_placement_drive(drive_id int)` after creating/opening a drive. The procedure reads `placement_drive` and calls T7 `is_eligible`. | Active student accounts passing T7's eligibility function; T8 does not duplicate eligibility logic. | Procedure calls six-argument `notify`, category `Placement`, key `placement-drive:<drive_id>`, inside the drive transaction. Unique recipient/event index handles concurrent retries. | `tests/db/placement.test.ts`, `tests/app/placement.test.ts`, and generic retry coverage. Owner: T7 owns source/eligibility; T8 owns delivery. |
| T8 grievance lifecycle — creation, assignment, progress, comments, resolution/rejection | Existing grievance insert/update/comment triggers. Identities: `grievance_id int`, assignment `assigned_at`, `comment_id bigint`, status transition. | Active admins on creation; assignee and raiser on assignment; other current participants on comments; raiser and assignee on close. | Triggers call six-argument `notify`; stable keys use grievance ID plus creation, transition/assignment identity, or comment ID. Trigger validation and notifications are atomic with the grievance write. | `automatic-notice.test.ts`, `grievance.test.ts`, `app/grievance.test.ts`. Owner: T8. |

T1 and T5 publication producers remain explicitly unconnected because their authoritative
workflows are absent. T2 leave decisions and T6 payment success events are wired in migrations 096
and 095 respectively. The optional fee branch in `user_alerts` remains guarded by `to_regclass`; migration 091 does
not create `v_student_fee_status`.

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
5. **Grievance notification:** as `STU202600004`, open `/student/grievances/new`, submit a grievance,
   then sign in as the admin and open `/admin/inbox` (or follow the notification bell). Confirm the
   unread **New grievance #...** notification appears under **For you**. Open it and verify that its
   link takes you to `/admin/grievances/:id`; opening it marks that notification read.
6. **Mark all read:** from `/admin/inbox`, leave at least one notification unread, then use
   **Mark all read (n)**. Confirm the inbox no longer shows the unread item and the notification bell
   reports no unread notifications.
