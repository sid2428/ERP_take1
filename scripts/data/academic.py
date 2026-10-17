"""G2 academic masters -> PostgreSQL-shaped tables.

G2 is the source of truth for departments, programs, courses, prerequisites and
curriculum placements. Changes made here (all recorded in the cleanup report):
  * course.l_t_p ("3-0-2") is split into lecture/tutorial/practical hour columns (1NF).
  * audit columns (created_by etc.) are replaced by the schema's own timestamps.
  * academic sessions 2019-ODD .. 2023-EVEN are added so graduated students can
    have a results history; G2's six sessions are kept unchanged.
  * the single G2 demo course_offering row is not imported: core courses are taught
    by division (G3 model) and offerings are used only for honors sections.
"""
from __future__ import annotations

import pandas as pd

from common import read_raw


def departments_raw() -> pd.DataFrame:
    return read_raw("01_DEPARTMENT.csv", dtype=str)


def programs() -> pd.DataFrame:
    p = read_raw("02_PROGRAM.csv")
    return p[["program_id", "dept_id", "program_name", "degree_level", "duration_years",
              "total_semesters", "total_credits_req", "intake_capacity"]].assign(is_active=True)


def courses() -> pd.DataFrame:
    c = read_raw("03_COURSE.csv")
    ltp = c.l_t_p.str.split("-", expand=True).astype(int)
    out = c[["course_id", "course_code", "course_name", "dept_id", "credits", "course_type"]].copy()
    out["lecture_hrs"], out["tutorial_hrs"], out["practical_hrs"] = ltp[0], ltp[1], ltp[2]
    out["syllabus_version"] = c.syllabus_version
    out["min_attendance_pct"] = 75
    out["is_active"] = c.is_active.astype(bool)
    return out


def prerequisites() -> pd.DataFrame:
    return read_raw("04_COURSE_PREREQUISITE.csv")[["course_id", "prereq_course_id", "min_grade"]]


def academic_sessions() -> pd.DataFrame:
    g2 = read_raw("05_ACADEMIC_SESSION.csv")
    rows = []
    for year in range(2019, 2024):
        ay = f"{year}-{str(year + 1)[2:]}"
        rows.append((f"{year}-ODD", f"Odd Semester {ay}", ay, "ODD", f"{year}-07-01", f"{year}-11-30", False))
        rows.append((f"{year}-EVEN", f"Even Semester {ay}", ay, "EVEN", f"{year + 1}-01-01", f"{year + 1}-05-31", False))
    older = pd.DataFrame(rows, columns=["session_id", "session_name", "academic_year", "term_type",
                                        "start_date", "end_date", "is_current"])
    g2 = g2[older.columns].assign(is_current=g2.is_current.astype(bool))
    return pd.concat([older, g2], ignore_index=True)


def curriculum() -> pd.DataFrame:
    return read_raw("06_PROGRAM_CURRICULUM.csv")[
        ["program_id", "course_id", "semester_no", "course_category", "elective_group"]]
