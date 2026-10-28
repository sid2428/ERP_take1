# Group 3 administration handoff

## Existing admin identity and authorization
- The role enum is `user_role` with the lowercase value `'admin'`; each account stores it in `app_user.role` (`migrations/007-auth-audit.sql`).
- The generated admin account uses login ID `admin`; `scripts/db/build-users.ts` provisions it and reads `ADMIN_PASSWORD`. Group 3 did not create a separate admin login or replace the portal's existing admin role.
- `src/middleware/auth.ts`: `currentUser()` loads the active account into `req.user`; `requireLogin()` requires a session; `requireRole(...roles)` compares `req.user.role`.
- `src/app.ts` mounts `/admin` behind `requireLogin` and `requireRole('admin')`. `src/routes/admin/index.ts` mounts admin feature routers.
- Unlock decisions also check `app_user.role = 'admin' AND is_active` inside `decideAttendanceUnlock()` in `src/queries/attendance-unlock-queries.ts`, providing a query-layer guard. Requesting checks the active faculty account and assignment in the same query module.
- This remains the portal's session-based `app_user` authentication, not Group 3 RBAC/JWT. The general admin pages, role, login, and middleware predate the attendance-unlock feature.

## Unlock and audit tables
Migration: `migrations/087-attendance-unlocks.sql` (schema `erp`).

- `attendance_unlock_request`: `request_id` PK; `session_id` FK; `requested_by` FK to `app_user`; required `reason` (1–500 trimmed characters); `status` (`pending`, `approved`, `rejected`); nullable `decided_by`, `decided_at`, `unlock_expires_at`; `created_at`. At most one pending request per session. Decisions require decision actor/time; only approvals have an expiry.
- `attendance_session_audit`: `audit_id` PK; `session_id`; `request_id`; `actor_id` FK to `app_user`; `action` (`attendance_edit`, `unlock_approved`, `unlock_rejected`); `occurred_at`; `old_value` and `new_value` JSONB. Attendance edit entries are tied to an unlock request; approval/rejection entries record the status change and approval expiry when applicable.

## Endpoints and callers
- Faculty request: `POST /faculty/attendance/assignments/:assignmentId/sessions/:sessionId/unlock-requests`, mounted by `src/routes/faculty-routes.ts` and implemented in `src/routes/faculty-attendance-routes.ts`. Active faculty may request only for their current-session assignment; body is `{ "reason": "..." }`. Returns `201` with the request ID and pending status.
- Admin queue: `GET /admin/attendance-unlocks`, implemented in `src/routes/admin/attendance-unlock-routes.ts`; admin-only via the `/admin` mount middleware. Renders pending requests.
- Approve: `POST /admin/attendance-unlocks/:id/approved`; reject: `POST /admin/attendance-unlocks/:id/rejected`. Admin-only, CSRF-protected form posts; `decideAttendanceUnlock()` rechecks active admin, rejects self-decisions, and permits only pending requests.
- Approval unlocks that single session for 48 hours. The faculty attendance save endpoint is `POST /faculty/attendance/assignments/:assignmentId/sessions`; lock enforcement and audit writes are in `src/queries/faculty-attendance-queries.ts`.

## Configuration and UI
- `LOCK_DAYS = 14` and `UNLOCK_HOURS = 48`: `src/lib/attendance-lock.ts`; re-exported from `src/config.ts`. Lock-date calculation uses `todayIso()` from `src/lib/format.ts` (Asia/Kolkata).
- `ATTENDANCE_WEEKEND_DAYS = [6, 7]` (ISO Saturday/Sunday): `src/config.ts`; consumed by `src/queries/faculty-attendance-queries.ts`.
- Group 3 added the admin queue page, not a minimal admin portal: route `GET /admin/attendance-unlocks`, EJS component `views/admin/attendance-unlocks.ejs`, and router `src/routes/admin/attendance-unlock-routes.ts`.

## Group 7 RBAC/JWT integration notes
- Replace the session-specific `req.user` identity/role source and `requireRole('admin')` gate in `src/app.ts` with Group 7's verified RBAC/JWT middleware; preserve active-account and faculty-to-assignment checks.
- Update the duplicate `'admin'`/`'faculty'` role literals and `app_user.user_id` actor lookup in `src/queries/attendance-unlock-queries.ts` and `src/queries/faculty-attendance-queries.ts` to use the canonical RBAC principal and audit-actor mapping.
- `LOCK_DAYS`, `UNLOCK_HOURS`, weekend days, request statuses, and audit action names are currently application/schema constants, not JWT claims. Keep them as policy/configuration values unless Group 7 defines a shared policy source; do not trust token-supplied unlock duration or request state.
