# Academic and course (T3)

## Data and rules

Core academic structure is `department`, `program`, `course`, `program_curriculum`,
`academic_session`, `division`, `batch`, `course_offering`, `student_enrollment` and
`teaching_assignment`. Migration 041 adds `elective_window`, `elective_window_offering`,
`elective_preference` and `elective_allocation`. Migration 042 adds `course_unit` and
`syllabus_coverage`.

Foreign keys scope offerings and enrollment to courses, students and academic sessions.
Elective database checks ensure an offering belongs to the window's session; its trigger guards
valid preferences; `allocate_electives(window_id)` fills seats from persisted preferences and
eligibility. Syllabus coverage's `unit_matches_session` trigger ensures the unit matches the
attendance session's course, and `tag_session_unit(session_id, unit_id, faculty_id)` records the
authorized faculty action. Views include `v_elective_allocation_summary`,
`v_student_elective_result`, `v_course_syllabus_progress`, `v_assignment_syllabus_summary` and
`v_student_syllabus_coverage`.

Example read-only checks:

```sql
SELECT * FROM erp.v_course_syllabus_progress LIMIT 10;
SELECT * FROM erp.v_elective_allocation_summary LIMIT 10;
```

The admin academic routes manage structure and elective windows; student elective choices and
faculty syllabus updates are scoped to their authenticated identity. Mutating routes validate
input, use transactions and write audit events.

## Demonstration

1. As admin, inspect academic structure and create or open an elective window with offerings.
2. As a student in that session, rank available choices and reload to confirm they persisted.
3. As admin, close the window and allocate; inspect allocation summary.
4. As a faculty member assigned to a course, record unit coverage for a conducted session, then
   inspect course progress. Verify another faculty member cannot edit that assignment.

Tests: `tests/db/academic.test.ts`, `tests/db/syllabus.test.ts`, `tests/app/academic.test.ts` and
`tests/app/syllabus.test.ts`.
