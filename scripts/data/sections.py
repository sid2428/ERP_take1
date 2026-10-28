"""Divisions, batches and section mapping (reused from G3) plus current-term enrollment.

Enrollment now follows the G2 curriculum (source of truth): a year-y student takes the
CORE and E1 courses placed in semester 2y-1 of BTECH-<dept>. About 15% of year-4 students
also take their department's honors (H1) course, taught in seat-limited course offerings.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from common import CURRENT_SESSION, HONORS_SECTION_SIZE, HONORS_SHARE, read_raw, rng
from report import Report


def divisions_and_batches(students_df: pd.DataFrame, report: Report):
    div = read_raw("attendance_divisions.csv")
    bat = read_raw("attendance_batches.csv")
    mp = read_raw("student_section_mapping.csv")

    divisions = pd.DataFrame({
        "division_id": div.division_id, "division_code": div.division_code,
        "dept_id": div.department_id, "academic_session_id": CURRENT_SESSION,
        "year_of_study": div.year_of_study, "semester": div.semester,
    })
    batches = pd.DataFrame({
        "batch_id": bat.batch_id, "batch_code": bat.batch_code, "division_id": bat.division_id,
        "batch_no": bat.batch_code.str.extract(r"-B(\d+)$")[0].astype(int),
    })
    sid = dict(zip(students_df.student_number, students_df.student_id))
    sections = pd.DataFrame({
        "student_id": mp.student_number.map(sid).astype(int), "academic_session_id": CURRENT_SESSION,
        "division_id": mp.division_id, "batch_id": mp.batch_id, "roll_no": mp.roll_no,
    })
    report.section("Divisions, batches and section mapping (G3, reused)")
    report.item("Divisions", len(divisions))
    report.item("Lab batches", len(batches))
    report.item("Active students mapped to a division and batch", len(sections))
    report.note("G3's stored strength, department, year and semester columns are dropped from batch and "
                "student_section: they can be derived from the division and the mapping (3NF).")
    return divisions, batches, sections


def enrollments(sections: pd.DataFrame, divisions: pd.DataFrame, students_df: pd.DataFrame,
                courses: pd.DataFrame, curriculum: pd.DataFrame, report: Report):
    """Return (student_enrollment, course_offering, honors section list)."""
    dinfo = divisions.set_index("division_id")
    prog = dict(zip(students_df.student_id, students_df.program_id))
    s = sections.assign(dept_id=sections.division_id.map(dinfo.dept_id),
                        year=sections.division_id.map(dinfo.year_of_study))
    s["program_id"] = s.student_id.map(prog)
    s["semester_no"] = 2 * s.year - 1

    regular = curriculum[(curriculum.course_category == "CORE") | (curriculum.elective_group == "E1")]
    enr = s.merge(regular[["program_id", "semester_no", "course_id"]], on=["program_id", "semester_no"])
    enr = enr[["student_id", "course_id"]].assign(offering_id=pd.NA)

    honors_courses = curriculum[(curriculum.elective_group == "H1") & (curriculum.semester_no == 7)]
    offerings, honors_rows, sections_out, oid = [], [], [], 0
    for _, hc in honors_courses.sort_values("program_id").iterrows():
        pool = s[(s.program_id == hc.program_id) & (s.year == 4)].student_id.to_numpy()
        chosen = np.sort(rng.choice(pool, size=round(len(pool) * HONORS_SHARE), replace=False))
        if len(chosen) == 0:
            continue
        n_sections = math.ceil(len(chosen) / HONORS_SECTION_SIZE)
        for k, members in enumerate(np.array_split(chosen, n_sections)):
            oid += 1
            offerings.append({"offering_id": oid, "course_id": int(hc.course_id),
                              "academic_session_id": CURRENT_SESSION, "section_name": chr(65 + k),
                              "max_seats": HONORS_SECTION_SIZE, "enrolled_count": len(members)})
            honors_rows.append(pd.DataFrame({"student_id": members, "course_id": int(hc.course_id),
                                             "offering_id": oid}))
            dept = courses.loc[courses.course_id == hc.course_id, "dept_id"].iloc[0]
            sections_out.append({"offering_id": oid, "course_id": int(hc.course_id), "dept_id": dept,
                                 "students": members})

    enr = pd.concat([enr, *honors_rows], ignore_index=True).sort_values(["student_id", "course_id"])
    enr.insert(0, "enrollment_id", np.arange(1, len(enr) + 1))
    enr["academic_session_id"] = CURRENT_SESSION
    enr["status"] = "Enrolled"
    offerings_df = pd.DataFrame(offerings)
    offerings_df["status"] = np.where(offerings_df.enrolled_count >= offerings_df.max_seats, "FULL", "OPEN")

    report.section("Current-term enrollment (2026-ODD, from the G2 curriculum)")
    report.item("Course enrollments (CORE + E1 for everyone; H1 honors for selected year-4 students)", len(enr))
    report.item("Honors (H1) offerings / sections", len(offerings_df))
    report.item("Honors students", sum(len(x["students"]) for x in sections_out))
    return enr[["enrollment_id", "student_id", "course_id", "academic_session_id", "offering_id", "status"]], \
        offerings_df, sections_out
