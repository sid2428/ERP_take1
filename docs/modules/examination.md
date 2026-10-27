# Examination (T5)

## Data and rules

Migration 084 adds `grade_scale`, `course_exam_scheme`, `exam_cycle`, `exam_schedule`,
`exam_registration`, `hall_ticket`, `exam_marks`, `course_result`, `semester_result` and
`student_cgpa`. Migration 085 adds examination analytics; 088 defines course-type mark schemes and
database maximum checks; 089 adds `refresh_exam_results()`.

The attendance eligibility trigger prevents registration below the required attendance. Marks are
bounded by each course's scheme, and result rows are checked against the same maxima. The student
API scopes exam registrations, hall tickets and results to the authenticated `student_id`. Faculty
marks entry is scoped to the faculty's assigned roster and active exam cycle and saves marks/results
in a transaction. Views include `v_student_result_sheet`, `v_student_exam_timetable`,
`v_faculty_marks_entry`, `v_attendance_defaulters_by_division` and `v_student_cgpa_rank`.

```sql
SELECT * FROM erp.v_student_result_sheet LIMIT 10;
SELECT * FROM erp.v_student_exam_timetable LIMIT 10;
```

The repository has no exam timetable/results publication state or caller. Saving exam data is not a
publication event, so T5 publication announcements are not emitted until T5 supplies that workflow.

## Demonstration

1. As faculty, open `/faculty/examination`, choose a permitted course and active cycle, and enter
   marks within the displayed component maxima.
2. Confirm an over-maximum mark is rejected and the valid submission updates the course result.
3. As the same student, inspect `/student/exams`, `/student/hall-ticket` and `/student/results`;
   confirm the data is scoped to that student.
4. Do not present saved marks as a published exam timetable/results announcement.

Tests: `tests/db/group3-examination.test.ts`, `tests/app/faculty-examination.test.ts`,
`tests/app/student-api.test.ts` and `tests/unit/faculty-examination-marks.test.ts`.
