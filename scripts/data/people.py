"""Students (G1 CSV, cleaned) and generated faculty (G6 data is not available)."""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd

from common import DEPT_SHORT, read_raw, rng
from report import Report

STUDENT_COLUMNS = [
    "student_id", "student_number", "first_name", "middle_name", "last_name", "date_of_birth",
    "gender", "blood_group", "email", "personal_email", "mobile_number", "alternate_mobile",
    "category", "nationality", "status", "admission_number", "admission_date", "admission_type",
    "admission_year", "program_id", "district_name", "address", "pincode",
]


def _random_dates(base: list[dt.date], max_offset_days: int) -> list[dt.date]:
    offsets = rng.integers(0, max_offset_days + 1, len(base))
    return [b + dt.timedelta(days=int(o)) for b, o in zip(base, offsets)]


def students(report: Report) -> tuple[pd.DataFrame, pd.Series]:
    """Return (student table, cohort year per student_id).

    The cohort year is the year the student's batch started semester 1; G3 derived
    year of study from it (2026 -> Y1 ... 2023 -> Y4).
    """
    st = read_raw("students (3).csv", encoding="cp1252", dtype=str)
    st = st.sort_values("student_number").reset_index(drop=True)
    st.insert(0, "student_id", np.arange(1, len(st) + 1))
    report.section("Students (students (3).csv, 50,000 rows)")
    report.item("Re-encoded from Windows-1252 to UTF-8", len(st))

    curly = st.last_name.str.contains("’")
    st["last_name"] = st.last_name.str.replace("’", "'")
    for col in ("email", "personal_email"):
        st[col] = st[col].str.replace("’", "")
    report.item("Curly apostrophe in surname replaced with ' (and removed from both e-mail addresses)", int(curly.sum()))

    cohort = st.admission_number.str[3:7].astype(int)
    graduated = st.status == "Graduated"
    cohort[graduated] = rng.integers(2019, 2023, int(graduated.sum()))
    report.item("Graduated students given a 2019-2022 cohort (their admission numbers said 2023-2026)", int(graduated.sum()))

    impossible_lateral = (st.admission_type == "Lateral Entry") & (cohort == 2026)
    st.loc[impossible_lateral, "admission_type"] = "Regular"
    report.item("Lateral-entry students in a first-year cohort reclassified as Regular", int(impossible_lateral.sum()))

    lateral = st.admission_type == "Lateral Entry"
    admission_year = cohort + lateral.astype(int)          # lateral entry joins directly in year 2
    new_number = "ADM" + admission_year.astype(str) + st.admission_number.str[7:]
    report.item("Admission numbers re-stamped to match the admission year", int((new_number != st.admission_number).sum()))
    st["admission_number"] = new_number
    st["admission_year"] = admission_year

    adm_dates = _random_dates([dt.date(int(y), 7, 1) for y in admission_year], 50)   # 1 Jul - 20 Aug
    min_age = np.where(lateral, 19.0, 17.0)
    ages = min_age + rng.random(len(st)) * 2.0
    dobs = [d - dt.timedelta(days=int(a * 365.25)) for d, a in zip(adm_dates, ages)]
    report.item("Admission dates regenerated within 1 Jul - 20 Aug of the admission year", len(st))
    report.item("Dates of birth regenerated (age 17-19 at admission; 19-21 for lateral entry)", len(st))
    st["admission_date"] = [d.isoformat() for d in adm_dates]
    st["date_of_birth"] = [d.isoformat() for d in dobs]

    st["program_id"] = "BTECH-" + st.dept_id
    report.item("Linked to a program (BTECH-<dept>); department_name dropped as it depends on the program", len(st))
    report.note("student_number keeps its STU2026 prefix for every student: it is the key used by the G3 and fee datasets.")

    return st[STUDENT_COLUMNS], pd.Series(cohort.values, index=st.student_id)


def faculty(counts: dict[str, int], students_df: pd.DataFrame, report: Report) -> pd.DataFrame:
    """Generate faculty per department. Faculty #1 of each department is its HOD."""
    first_by_gender = {g: students_df.loc[students_df.gender == g, "first_name"].unique()
                       for g in ("Male", "Female")}
    last_names = students_df.last_name.unique()
    rows, fid = [], 0
    for dept in sorted(counts):
        for n in range(1, counts[dept] + 1):
            fid += 1
            gender = "Male" if rng.random() < 0.5 else "Female"
            first = str(rng.choice(first_by_gender[gender]))
            last = str(rng.choice(last_names))
            if n == 1:
                designation = "Professor"
            else:
                designation = str(rng.choice(["Professor", "Associate Professor", "Assistant Professor"],
                                             p=[0.12, 0.28, 0.60]))
            join_from, join_to = {"Professor": (1995, 2012), "Associate Professor": (2005, 2018),
                                  "Assistant Professor": (2012, 2025)}[designation]
            joined = dt.date(int(rng.integers(join_from, join_to + 1)), int(rng.choice([6, 7])), 1)
            qualification = "Ph.D." if designation != "Assistant Professor" or rng.random() < 0.35 else "M.Tech"
            handle = f"{first}.{last}".lower().replace("'", "").replace(" ", "")
            rows.append({
                "faculty_id": fid,
                "faculty_code": f"FAC-{DEPT_SHORT[dept]}-{n:03d}",
                "first_name": first, "last_name": last, "gender": gender, "dept_id": dept,
                "designation": designation, "qualification": qualification,
                "date_of_joining": joined.isoformat(),
                "email": f"{handle}.{fid}@univ.edu",
                "mobile_number": f"{int(rng.choice([7, 8, 9]))}{int(rng.integers(0, 10**9)):09d}",
                "status": "Active",
            })
    df = pd.DataFrame(rows)
    report.section("Faculty (generated: the G6 dataset is not available)")
    report.item("Faculty generated, sized so teaching load stays near 16 h/week", len(df))
    report.note("Faculty #1 of each department (FAC-<dept>-001) is the HOD, matching G2's hod_faculty_id codes.")
    return df
