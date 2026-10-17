"""Regenerated attendance (3 Aug - 16 Oct 2026) in the compact storage format.

One row per conducted/cancelled session; `absent_student_ids` lists only the absentees, so
the present list is the assignment roster minus that array (lossless). The presence model
is G3's: a per-student base propensity, a per-course shift (labs attended slightly more),
a decline over the term and weaker Mondays/Fridays.
"""
from __future__ import annotations

import datetime as dt
from collections import defaultdict

import numpy as np
import pandas as pd

from common import CANCEL_PROBABILITY, PERIOD_TIMES, TERM_START, pg_int_array, rng, teaching_days
from report import Report

DOW_EFFECT = {1: -0.15, 2: 0.0, 3: 0.05, 4: 0.0, 5: -0.25}


def rosters(assignments: pd.DataFrame, sections: pd.DataFrame, honors_sections) -> dict[int, np.ndarray]:
    by_div = sections.groupby("division_id").student_id.apply(np.sort).to_dict()
    by_batch = sections.groupby("batch_id").student_id.apply(np.sort).to_dict()
    by_off = {h["offering_id"]: np.sort(h["students"]) for h in honors_sections}
    out = {}
    for a in assignments.itertuples(index=False):
        if pd.notna(a.offering_id):
            out[a.assignment_id] = by_off[int(a.offering_id)]
        elif pd.notna(a.batch_id):
            out[a.assignment_id] = by_batch[int(a.batch_id)]
        else:
            out[a.assignment_id] = by_div[int(a.division_id)]
    return out


def generate(assignments: pd.DataFrame, entries: pd.DataFrame, roster: dict[int, np.ndarray],
             n_students: int, report: Report) -> pd.DataFrame:
    days = teaching_days()
    weeks = (days[-1] - TERM_START).days // 7 + 1
    dates_by_dow = defaultdict(list)
    for d in days:
        dates_by_dow[d.isoweekday()].append(d)

    base_p = np.clip(rng.beta(9, 2, size=n_students + 1), 0.05, 0.995)
    base_logit = np.log(base_p / (1 - base_p))                  # indexed by student_id
    sigmoid = lambda x: 1 / (1 + np.exp(-x))

    entries_by_a = entries.groupby("assignment_id")
    rows, sid, cells, absences = [], 0, 0, 0
    for a in assignments.itertuples(index=False):
        ents = entries_by_a.get_group(a.assignment_id)
        sched = sorted((d, e.start_period, e.periods, e.entry_id)
                       for e in ents.itertuples(index=False) for d in dates_by_dow[e.day_of_week])
        studs = roster[a.assignment_id]
        cancelled = rng.random(len(sched)) < CANCEL_PROBABILITY
        conducted = [i for i in range(len(sched)) if not cancelled[i]]
        if conducted:
            shift = rng.normal(0.35 if a.session_type == "Lab" else 0.0, 0.35, size=len(studs))[:, None]
            trend = np.array([0.3 - 0.45 * (((sched[i][0] - TERM_START).days // 7) / max(weeks - 1, 1))
                              + DOW_EFFECT[sched[i][0].isoweekday()] for i in conducted])
            present = rng.random((len(studs), len(conducted))) < sigmoid(base_logit[studs][:, None] + shift + trend[None, :])
        col = {i: k for k, i in enumerate(conducted)}
        for i, (day, start, periods, entry_id) in enumerate(sched):
            sid += 1
            if cancelled[i]:
                absent, status, marked_at = [], "Cancelled", ""
            else:
                absent = studs[~present[:, col[i]]]
                status = "Conducted"
                end_h, end_m = map(int, PERIOD_TIMES[start + periods - 1][1].split(":"))
                lag = int(rng.integers(0, 180))
                marked_at = (dt.datetime.combine(day, dt.time(end_h, end_m)) + dt.timedelta(minutes=lag)).isoformat(sep=" ")
                cells += len(studs)
                absences += len(absent)
            rows.append((sid, a.assignment_id, entry_id, day.isoformat(), i + 1, start, float(periods),
                         status, pg_int_array(absent), a.faculty_id, marked_at))
    df = pd.DataFrame(rows, columns=["session_id", "assignment_id", "timetable_entry_id", "session_date",
                                     "session_number", "start_period", "duration_hrs", "session_status",
                                     "absent_student_ids", "marked_by", "marked_at"])
    report.section("Attendance (regenerated to match the curriculum and timetable)")
    report.item(f"Teaching days {days[0]} to {days[-1]} (holidays excluded)", len(days))
    report.item("Sessions (one row each; about 2% cancelled)", len(df))
    report.item("Student-session attendance marks represented (roster x conducted sessions)", cells)
    report.item(f"Absences stored ({100 * absences / max(cells, 1):.1f}% of marks)", absences)
    report.note("Equivalent normalized rows are available through the view erp.v_attendance_record.")
    return df
