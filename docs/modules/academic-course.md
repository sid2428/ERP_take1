# Academic and course (T3)

Team T3 owns the academic structure (programs, curriculum, courses, offerings), elective selection
and syllabus coverage. Migrations: 002 and 004 (structure, from the base schema), 041 (electives),
042 to 044 (syllabus coverage). Everything lives in the `erp` schema.

## 1. Tables and keys

### Added by T3

| Table | Primary key | Unique | Foreign keys | Checks |
|---|---|---|---|---|
| `elective_window` | `window_id` | `(academic_session_id, semester_no, elective_group)` | `academic_session_id` to `academic_session`; `allocated_by` to `app_user` (set null on delete) | `semester_no` 1..12; `elective_group` is `O1` or `H1`; `max_choices` 1..5; `closes_at > opens_at`; `(status = 'Allocated') = (allocated_at IS NOT NULL)` |
| `elective_window_offering` | `(window_id, offering_id)` | | `window_id` to `elective_window` (cascade); `(offering_id, academic_session_id)` to `course_offering` (cascade) | trigger `same_session` |
| `elective_preference` | `(window_id, student_id, offering_id)` | `(window_id, student_id, preference_rank)` | `student_id` to `student`; `(window_id, offering_id)` to `elective_window_offering` (cascade) | `preference_rank` 1..5; trigger `window_guard` |
| `elective_allocation` | `(window_id, student_id)` | | `window_id` to `elective_window` (cascade); `student_id` to `student`; `offering_id` to `course_offering` (set null) | `preference_rank` 1..5; `merit_position > 0`; `merit_basis` is `CGPA` or `ATTENDANCE`; `(offering_id IS NULL) = (preference_rank IS NULL)` |
| `course_unit` | `unit_id` | `(course_id, unit_no)` | `course_id` to `course` (cascade) | `unit_no` 1..5; `unit_title` not blank; `planned_lectures` 1..30 |
| `syllabus_coverage` | `session_id` | | `session_id` to `attendance_session` (cascade); `unit_id` to `course_unit` (cascade) | trigger `unit_matches_session` |

Migration 041 also adds `UNIQUE (offering_id, academic_session_id)` to `course_offering`. It is what
lets `elective_window_offering` prove, with a composite foreign key, that an offering belongs to the
window's session. It also creates the enum `elective_window_status` (`Scheduled`, `Open`, `Closed`,
`Allocated`).

### Core structure (migrations 002 and 004)

`department`, `program`, `course`, `course_prerequisite`, `program_curriculum`, `academic_session`,
`division`, `batch`, `student_section`, `course_offering`, `student_enrollment`, `teaching_assignment`.
Keys that the T3 features rely on:

- `course`: primary key `course_id`, unique `course_code`, foreign key `dept_id` to `department`;
  checks on credits and weekly hours.
- `course_offering`: primary key `offering_id`, foreign keys to `course` and `academic_session`,
  `max_seats`, `enrolled_count`, `status` (`OPEN`, `FULL` or `CLOSED`).
- `student_enrollment`: unique `(student_id, course_id, academic_session_id)`, status `Enrolled` or
  `Dropped`, optional `offering_id`.
- `teaching_assignment`: primary key `assignment_id`, foreign keys to `course`, `faculty`,
  `academic_session` and the division, batch or offering taught.

## 2. Business rules and where each is enforced

### Electives

| Rule | Enforced by |
|---|---|
| A window closes after it opens; semester, group and choice count are in range | CHECK constraints on `elective_window` |
| Only one window per session, semester and group | UNIQUE on `elective_window` |
| A window is `Allocated` exactly when it has an allocation time | CHECK on `elective_window` |
| An offering in a window belongs to the window's session | composite FK plus trigger `same_session` |
| A student can only rank offerings listed in the window | FK `(window_id, offering_id)` |
| One offering per rank, and a rank is used once per student | UNIQUE and PK on `elective_preference` |
| Choices are accepted only while the window is `Open` and inside its dates | trigger `window_guard` (insert, update and delete) |
| A rank cannot exceed the window's `max_choices` | trigger `window_guard` |
| Only active students can choose | trigger `window_guard` |
| An open elective (`O1`) must be from another department than the student's program | trigger `window_guard` |
| A window is allocated only after it is `Closed`, and only once | procedure `allocate_electives` |
| Seats are given in merit order, a student gets the highest-ranked choice that still has a seat, and seats are never exceeded | procedure `allocate_electives` plus the seat trigger `enrollment_seats` |
| Every applicant gets one result row; no seat means no offering and no rank | CHECK on `elective_allocation` |
| Only the admin manages windows; a student sees and changes only their own choices | app: role middleware and per-student queries |
| A student cannot save choices for a window that is not open for them | app: `POST /student/electives/:windowId` returns an error message or 404 |

### Syllabus coverage

| Rule | Enforced by |
|---|---|
| A course has at most 5 units; unit titles are not blank; planned lectures are 1 to 30 | CHECK and UNIQUE on `course_unit` |
| A session is tagged with at most one unit | primary key on `syllabus_coverage.session_id` |
| Only a conducted session can be tagged | trigger `unit_matches_session` |
| The unit must belong to the course taught in the session | trigger `unit_matches_session` |
| Only the faculty member who took the session can tag or re-tag it | procedure `tag_session_unit` |
| A unit never counts above 100% | `LEAST(delivered, planned)` in the views |
| A faculty member sees syllabus coverage only for their own classes | app: `/faculty/classes/:id/syllabus` returns 404 for other classes |

### Curriculum

| Rule | Enforced by |
|---|---|
| Prerequisites cannot form a cycle | trigger `prerequisite_no_cycle` |
| A course cannot be placed in a semester beyond the program duration | trigger `curriculum_semester_in_range` |
| Only one academic session is current | partial unique index plus `set_current_session()` |

## 3. Triggers, procedures and views

Run the examples against a local database. Examples that raise an error should be run inside
`BEGIN; ... ROLLBACK;` so nothing is kept.

### Triggers

**`window_guard`** (before insert, update or delete on `elective_preference`) rejects choices outside
the open window, over the rank limit, from inactive students, or from the student's own department for
an open elective. Window 1 is a placeholder for any window id.

```sql
BEGIN;
UPDATE erp.elective_window SET status = 'Closed' WHERE window_id = 1;
INSERT INTO erp.elective_preference (window_id, student_id, offering_id, preference_rank)
VALUES (1, 1, 1, 1);          -- ERROR: elective window 1 is not open for choices
ROLLBACK;
```

**`same_session`** (before insert or update on `elective_window_offering`) rejects an offering from a
different session than the window.

**`unit_matches_session`** (before insert or update on `syllabus_coverage`) rejects a cancelled session
or a unit of another course.

```sql
BEGIN;
INSERT INTO erp.syllabus_coverage (session_id, unit_id)
SELECT s.session_id, u.unit_id
FROM erp.attendance_session s
JOIN erp.teaching_assignment ta USING (assignment_id)
JOIN erp.course_unit u ON u.course_id <> ta.course_id
WHERE s.session_status = 'Conducted' LIMIT 1;   -- ERROR: unit ... does not belong to the course taught in session ...
ROLLBACK;
```

### Procedures

**`allocate_electives(p_window_id, p_admin_user_id DEFAULT NULL)`** allocates a `Closed` window. It ranks
the applicants by merit and gives each the highest-ranked choice that still has a seat. Seats are written
through `student_enrollment`, so the existing seat trigger keeps `enrolled_count` and `OPEN` or `FULL`
correct. The window then becomes `Allocated`. The admin page calls it, and it runs in one transaction.

```sql
CALL erp.allocate_electives(1, NULL);           -- window 1 must be Closed
SELECT * FROM erp.v_student_elective_result WHERE window_id = 1 ORDER BY merit_position LIMIT 10;
```

Merit is CGPA when the view `v_student_academic_standing` exists. Otherwise it is the student's overall
attendance percentage in the running session (`v_student_attendance_overall`). Students without a merit
value rank last, and ties are broken by `student_id`. The exam module currently exposes `student_cgpa`, not that view, so today merit is the attendance percentage. Pointing the procedure at `student_cgpa` is a small follow-up change.

**`tag_session_unit(p_session_id, p_unit_id, p_faculty_id)`** tags a session with a unit and replaces an
earlier tag. It fails unless that faculty member took the session.

```sql
CALL erp.tag_session_unit(12345, 678, 90);      -- session, unit, faculty ids; use real ids
```

### Views

| View | What it shows | Example |
|---|---|---|
| `v_elective_allocation_summary` | per window and offering: seats, applicants, first-choice applicants, allocated | see below |
| `v_student_elective_result` | per student and window: outcome, course, choice number, merit position and basis | see below |
| `v_course_syllabus_progress` | per class and unit: planned vs delivered lectures and percentage | see below |
| `v_assignment_syllabus_summary` | per class: overall planned, delivered, units done and percentage | see below |
| `v_student_syllabus_coverage` | per student and course: the coverage of the class the student sits in | see below |

```sql
SELECT course_code, section_name, max_seats, applicants, first_choice_applicants, allocated, seats_left
FROM erp.v_elective_allocation_summary WHERE window_id = 1 ORDER BY applicants DESC;

SELECT course_code, section_name, choice_got, merit_position, merit_basis, outcome
FROM erp.v_student_elective_result
WHERE window_id = 1 AND student_id = (SELECT student_id FROM erp.student WHERE student_number = 'STU202600004');

SELECT unit_no, unit_title, planned_lectures, delivered, pct
FROM erp.v_course_syllabus_progress
WHERE assignment_id = (SELECT min(assignment_id) FROM erp.teaching_assignment) ORDER BY unit_no;

SELECT assignment_id, planned_total, delivered_total, units_done, units_total, pct
FROM erp.v_assignment_syllabus_summary ORDER BY pct LIMIT 5;

SELECT course_id, planned_total, delivered_total, units_done, units_total, pct
FROM erp.v_student_syllabus_coverage
WHERE student_id = (SELECT student_id FROM erp.student WHERE student_number = 'STU202600004');
```

## 4. Pages

| Page | Who | What it does |
|---|---|---|
| `/admin/electives` | admin | list windows; create a window (session, semester, group, dates, max choices) |
| `/admin/electives/:id` | admin | add existing offerings or create new ones with seats; open, close and allocate; see the seat summary and the results |
| `/student/electives` | student | rank choices while a window is open (one dropdown per allowed choice); see the result after allocation |
| `/faculty/classes/:id/syllabus` | faculty | overall bar, planned vs delivered lectures per unit, and the unit of each recent session; 404 for another teacher's class |
| `/faculty/classes` | faculty | a Syllabus column with a progress bar for each class |
| `/student/offerings` | student | a "Syllabus covered" bar and units done for each enrolled course |
| `/admin/programs/:id` | admin | placed credits per semester, a warning when the total differs from the credits the program requires, and an SVG prerequisite graph |

## 5. Seed data and design notes

- Migration 043 gives every one of the 182 courses 5 units (910 rows). Theory courses have real unit
  titles. Labs and tutorials use a standard five-part layout named after the course. Planned lectures
  per unit: 11 for a 4-hour course, 9 for a 3-hour course, 4 for a lab and 3 for a tutorial.
- Migration 044 tags the existing conducted attendance sessions in date order against each course's unit
  plan, so the progress bars show real numbers (average about 61% when seeded). It can be re-run safely.
- A session has one unit. Faculty can tag sessions through `tag_session_unit`; the faculty page itself
  shows progress and does not have a tagging form.
- Merit currently uses the attendance percentage. The procedure switches to CGPA only if a view named `v_student_academic_standing` exists, and the exam module exposes `student_cgpa` instead.
- There is one window per session, semester and group. To offer more courses in the same window, add
  more offerings to it.

## 6. Tests

| File | Tests | What it checks |
|---|---|---|
| `tests/db/academic.test.ts` | 5 | choices rejected outside the dates and after closing; one offering per rank; seats never exceeded with fallback to the next choice; an open window cannot be allocated, and nothing is allocated twice |
| `tests/db/syllabus.test.ts` | 5 | unit and lecture limits; a unit of another course is rejected; a tagged session counts in the views; only the assigned faculty can tag; a cancelled session cannot be tagged |
| `tests/app/academic.test.ts` | 7 | signed-out visitors go to login; a student cannot open the admin pages; admin and student pages render; a window cannot be opened without offerings or close before it opens; a student cannot save choices for a window that is not theirs |
| `tests/app/syllabus.test.ts` | 6 | signed-out visitors go to login; a student gets 403 on the faculty page; faculty see their own class and get 404 on another; the class list and the student offerings page show the new columns |

## 7. Three-minute demo

Run this on the local database. Allocating a window changes enrollments for real, so do not do it on
the live site while students are still choosing. Use the demo accounts from the local credentials file
(`admin`, `STU202600004` and `FAC-CSE-074`); do not show passwords.

**0:00 to 0:20, introduction.** Say what T3 covers: academic structure, elective selection and syllabus
coverage. The rules live in the database: 3 triggers, 2 procedures and 5 views.

**0:20 to 1:20, scene 1: open a window and choose (admin, then student).**
1. Sign in as `admin`, open Electives and create a window: group, semester, dates and 3 choices. If the
   form says "That record already exists", that session, semester and group already has a window; open it
   instead.
2. Open the window, add offerings with seat counts (add an existing offering or create a new one), then
   click Open.
3. Sign in as `STU202600004`, open Electives, rank the choices and save. Say: "The window rule is a trigger, not just the page."

**1:20 to 2:20, scene 2: allocate (admin, then student).**
1. As admin, close the window and click Allocate. Show the summary: applicants, first-choice applicants,
   seats and how many were allocated. Say: "The procedure serves students in merit order, gives each the
   highest-ranked choice with a free seat and never exceeds the seats. Merit is the attendance percentage for now."
2. As the student, reload Electives: "You got ... your choice #n", with the merit position and basis.
3. Optional proof: as the student, open `/admin/electives` and show the 403.

**2:20 to 3:00, scene 3: syllabus coverage (faculty, then student).**
1. Sign in as `FAC-CSE-074`, open My classes and show the Syllabus column. Click Units on a class: one bar
   per unit with planned vs delivered lectures, and the unit of each recent session.
2. Sign in as `STU202600004`, open Course offerings and show "Syllabus covered" for each course. Say:
   "Same data, read from a view. A session can be tagged only with a unit of its own course, only if it was
   conducted, and only by the teacher who took it. The database enforces that."

If time is short, skip creating the window in scene 1 and use a window that is already open.
