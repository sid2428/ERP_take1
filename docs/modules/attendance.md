# Attendance (T4)

## Data and rules

`attendance_session` stores a conducted/cancelled class and its absent student IDs;
`attendance_summary` stores per-student/course/session totals. `attendance_correction`,
`attendance_unlock_request` and `attendance_session_audit` record requested corrections, approvals
and audited edits. Assignment rosters, sessions, students and academic sessions are linked by
foreign keys.

Database checks enforce positive periods/durations, valid statuses, one session per assignment/date,
valid roster membership and dates within the term. `validate` checks session writes;
`keep_summary` calls `refresh_attendance_summary` after session changes. Shared views include
`v_assignment_roster`, `v_attendance_record`, `v_student_attendance_overall` and
`v_student_attendance_by_course`. Correction approval is admin-only and writes an audit trail;
older sessions require an active session-specific unlock approval. Faculty access is scoped to
their teaching assignments.

```sql
SELECT * FROM erp.v_student_attendance_overall LIMIT 10;
SELECT * FROM erp.v_student_attendance_by_course LIMIT 10;
```

Relevant migrations are 004, 006, 086 and 087. Shortage notifications are emitted from persisted
attendance-summary changes and share the source transaction; see `docs/modules/notices.md`.

## Demonstration

1. As faculty, open `/faculty/attendance`, select an assigned class/date and record attendance.
2. Check that student attendance summary changes after the save.
3. Attempt to mark a student outside the roster and confirm the database rejects it.
4. Request an edit to a locked historical session; as admin approve/reject it, then verify the
   audit entry and resulting attendance.

Tests: `tests/db/constraints.test.ts`, `tests/app/faculty-attendance.test.ts`,
`tests/unit/attendance-unlock.test.ts` and `tests/app/portal.test.ts`.
