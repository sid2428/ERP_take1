"""Shared paths, constants and CSV helpers for the data pipeline.

Every generated file is written to data/generated/<table>.csv with a header row
that matches the PostgreSQL column names, so scripts/db/load.ts can COPY it directly.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT                      # group CSVs live at the repo root (gitignored)
OUT = ROOT / "data" / "generated"
REPORTS = ROOT / "data" / "reports"

SEED = 2026
rng = np.random.default_rng(SEED)

# Current term (G2: 2026-ODD is the single current session).
CURRENT_SESSION = "2026-ODD"
ACADEMIC_YEAR = "2026-27"
TERM_START = dt.date(2026, 8, 3)         # first teaching day (from the G3 generator)
DATA_UPTO = dt.date(2026, 10, 16)        # last day with generated attendance
HOLIDAYS = {dt.date(2026, 9, 14), dt.date(2026, 10, 2)}
CANCEL_PROBABILITY = 0.02

# Timetable grid: Mon..Fri x 6 one-hour periods; labs take two consecutive periods.
DAYS = [1, 2, 3, 4, 5]
PERIODS = [1, 2, 3, 4, 5, 6]
PERIOD_TIMES = {
    1: ("09:00", "10:00"), 2: ("10:00", "11:00"),
    3: ("11:15", "12:15"), 4: ("12:15", "13:15"),
    5: ("14:00", "15:00"), 6: ("15:00", "16:00"),
}
LAB_START_PERIODS = [1, 3, 5]
# Year-4 honors sections meet dept-wide in these reserved (day, period) slots.
HONORS_SLOTS = [(2, 6), (3, 6), (4, 6), (5, 6)]
HONORS_SHARE = 0.15
HONORS_SECTION_SIZE = 60

# Faculty workload caps (hours/week) used when sizing and assigning faculty.
FACULTY_TARGET_HOURS = 16
FACULTY_MAX_HOURS = 18
HOD_MAX_HOURS = 8

# Short codes used in faculty codes (G2 uses FAC-CIVL-001 for CIVIL).
DEPT_SHORT = {"AIDS": "AIDS", "CIVIL": "CIVL", "CSE": "CSE", "EE": "EE",
              "ENTC": "ENTC", "IT": "IT", "MECH": "MECH"}


def read_raw(name: str, **kw) -> pd.DataFrame:
    return pd.read_csv(RAW / name, **kw)


def write_table(table: str, df: pd.DataFrame) -> None:
    """Write a table CSV (UTF-8, empty string = NULL)."""
    OUT.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUT / f"{table}.csv", index=False, lineterminator="\n")
    print(f"  wrote {table:<24} {len(df):>9,} rows")


def pg_int_array(values) -> str:
    """Format an iterable of ints as a PostgreSQL array literal, e.g. {3,8,15}."""
    return "{" + ",".join(str(int(v)) for v in values) + "}"


def teaching_days(start: dt.date = TERM_START, end: dt.date = DATA_UPTO) -> list[dt.date]:
    days, d = [], start
    while d <= end:
        if d.weekday() < 5 and d not in HOLIDAYS:
            days.append(d)
        d += dt.timedelta(days=1)
    return days
