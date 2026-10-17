"""Build every table for the unified ERP database from the group datasets.

Usage:  python scripts/data/build_dataset.py
Output: data/generated/<table>.csv  +  data/reports/data-cleanup-report.md
Then:   npm run db:migrate && npm run db:load
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")

import academic          # noqa: E402
import attendance        # noqa: E402
import people            # noqa: E402
import sections          # noqa: E402
import timetable         # noqa: E402
from common import write_table   # noqa: E402
from report import Report        # noqa: E402


def main() -> None:
    t0 = time.time()
    report = Report()

    print("1/6 academic structure (G2)")
    depts_raw = academic.departments_raw()
    programs, courses = academic.programs(), academic.courses()
    prereqs, sessions_df, curriculum = academic.prerequisites(), academic.academic_sessions(), academic.curriculum()
    report.section("Academic structure (G2)")
    report.item("Departments", len(depts_raw))
    report.item("Programs", len(programs))
    report.item("Courses (l_t_p split into lecture/tutorial/practical hours)", len(courses))
    report.item("Prerequisite links", len(prereqs))
    report.item("Curriculum placements", len(curriculum))
    report.item("Academic sessions (G2's 6 + 10 generated for 2019-2023)", len(sessions_df))
    report.note("G2's single demo course_offering row is not imported; offerings are generated for honors sections.")

    print("2/6 students (cleaned)")
    students_df, _cohort = people.students(report)

    print("3/6 divisions, batches, enrollment")
    divisions, batches, section_map = sections.divisions_and_batches(students_df, report)
    enrollment, offerings, honors = sections.enrollments(section_map, divisions, students_df, courses, curriculum, report)

    print("4/6 faculty + timetable")
    units = timetable.build_units(divisions, batches, courses, curriculum, honors)
    faculty = people.faculty(timetable.faculty_counts(units), students_df, report)
    assignments, entries, rooms, slots, offerings = timetable.schedule(
        units, faculty, divisions, batches, depts_raw, offerings, report)

    print("5/6 attendance")
    roster = attendance.rosters(assignments, section_map, honors)
    att_sessions = attendance.generate(assignments, entries, roster, len(students_df), report)

    print("6/6 writing tables")
    code_to_id = dict(zip(faculty.faculty_code, faculty.faculty_id))
    departments = depts_raw.assign(hod_faculty_id=depts_raw.hod_faculty_id.map(code_to_id).astype("Int64"),
                                   is_active=depts_raw.is_active == "1")
    departments = departments[["dept_id", "dept_name", "hod_faculty_id", "office_room", "contact_email",
                               "established_year", "is_active"]]
    for table, df in [
        ("department", departments), ("program", programs), ("course", courses),
        ("course_prerequisite", prereqs), ("academic_session", sessions_df),
        ("program_curriculum", curriculum), ("faculty", faculty), ("student", students_df),
        ("division", divisions), ("batch", batches), ("student_section", section_map),
        ("course_offering", offerings[["offering_id", "course_id", "academic_session_id", "faculty_id",
                                       "section_name", "max_seats", "enrolled_count", "room_id", "status"]]),
        ("student_enrollment", enrollment), ("room", rooms), ("time_slot", slots),
        ("teaching_assignment", assignments), ("timetable_entry", entries),
        ("attendance_session", att_sessions),
    ]:
        write_table(table, df)
    report.save()
    print(f"done in {time.time() - t0:.0f}s -> data/generated/, report in data/reports/")


if __name__ == "__main__":
    main()
