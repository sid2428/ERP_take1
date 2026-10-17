"""Teaching assignments, rooms and a clash-free weekly timetable.

Units of teaching (G3 model): a theory/tutorial course is taught to a whole division,
a lab course to each lab batch (two consecutive periods), and an honors course to each
honors offering in the reserved year-4 slots. One teaching assignment = one faculty.

Constraints enforced while scheduling (and again in PostgreSQL by exclusion constraints):
a division (or batch), a faculty member and a room are never double-booked.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field

import pandas as pd

from common import (CURRENT_SESSION, DAYS, DEPT_SHORT, FACULTY_MAX_HOURS, FACULTY_TARGET_HOURS,
                    HOD_MAX_HOURS, HONORS_SLOTS, LAB_START_PERIODS, PERIOD_TIMES, PERIODS, rng)
from report import Report

CLASSROOM_CAPACITY, LAB_CAPACITY = 80, 30


@dataclass
class Unit:
    course_id: int
    course_dept: str
    session_type: str              # 'Lecture' | 'Lab'
    weekly: int                    # sessions per week
    periods: int                   # periods per session (lab = 2)
    division_id: int | None = None
    batch_id: int | None = None
    batch_no: int | None = None
    offering_id: int | None = None
    room_dept: str = ""
    entries: list[tuple[int, int, int]] = field(default_factory=list)   # (day, start_period, room_id)
    faculty_id: int | None = None

    @property
    def hours(self) -> int:
        return self.weekly * self.periods


def build_units(divisions, batches, courses, curriculum, honors_sections) -> list[Unit]:
    cinfo = courses.set_index("course_id")
    batches_by_div = batches.groupby("division_id")[["batch_id", "batch_no"]].apply(
        lambda g: list(g.itertuples(index=False, name=None))).to_dict()
    regular = curriculum[(curriculum.course_category == "CORE") | (curriculum.elective_group == "E1")]
    units: list[Unit] = []
    for d in divisions.itertuples(index=False):
        program, sem = f"BTECH-{d.dept_id}", 2 * d.year_of_study - 1
        for cid in regular[(regular.program_id == program) & (regular.semester_no == sem)].course_id:
            c = cinfo.loc[cid]
            if c.course_type == "LAB":
                for bid, bno in batches_by_div[d.division_id]:
                    units.append(Unit(int(cid), c.dept_id, "Lab", 1, 2, d.division_id, bid, bno, room_dept=d.dept_id))
            else:
                weekly = int(c.lecture_hrs) if c.course_type == "TH" else int(c.tutorial_hrs)
                units.append(Unit(int(cid), c.dept_id, "Lecture", weekly, 1, d.division_id, room_dept=d.dept_id))
    for h in honors_sections:
        weekly = int(cinfo.loc[h["course_id"]].lecture_hrs)
        units.append(Unit(h["course_id"], h["dept_id"], "Lecture", weekly, 1,
                          offering_id=h["offering_id"], room_dept=h["dept_id"]))
    return units


def faculty_counts(units: list[Unit]) -> dict[str, int]:
    hours: dict[str, int] = defaultdict(int)
    for u in units:
        hours[u.course_dept] += u.hours
    return {d: 1 + math.ceil(max(h - HOD_MAX_HOURS, 0) / FACULTY_TARGET_HOURS) for d, h in hours.items()}


class Scheduler:
    def __init__(self, faculty: pd.DataFrame, divisions: pd.DataFrame, batches: pd.DataFrame,
                 buildings: dict[str, str]):
        self.fac_by_dept = faculty.groupby("dept_id").faculty_id.apply(list).to_dict()
        self.cap = {f: (HOD_MAX_HOURS if code.endswith("-001") else FACULTY_MAX_HOURS)
                    for f, code in zip(faculty.faculty_id, faculty.faculty_code)}
        self.load: dict[int, int] = defaultdict(int)
        self.courses_of: dict[int, set[int]] = defaultdict(set)
        self.fac_busy: dict[int, set] = defaultdict(set)
        self.room_busy: dict[int, set] = defaultdict(set)
        self.rooms: list[dict] = []
        self.rooms_by: dict[tuple[str, str], list[int]] = defaultdict(list)
        self.buildings = buildings
        self.home_rooms: dict[tuple, list[int]] = defaultdict(list)   # rooms a division already uses
        self.n_batches = batches.groupby("division_id").size().to_dict()
        # div_busy[div][(day, period)] = set of batch numbers occupied (a lecture occupies all)
        self.div_busy: dict[int, dict] = defaultdict(lambda: defaultdict(set))
        for d in divisions[divisions.year_of_study == 4].division_id:
            for slot in HONORS_SLOTS:                      # keep year-4 honors slots free
                self.div_busy[d][slot] = set(range(1, self.n_batches[d] + 1))

    # ---- rooms -------------------------------------------------------------------------
    def _room(self, dept: str, kind: str, slots: list, prefer: list[int]) -> int:
        for rid in prefer + self.rooms_by[(dept, kind)]:
            if not any(s in self.room_busy[rid] for s in slots):
                return rid
        rid = len(self.rooms) + 1
        n = len(self.rooms_by[(dept, kind)]) + 1
        code = f"{DEPT_SHORT[dept]}-{'CR' if kind == 'Classroom' else 'LAB'}-{n:03d}"
        self.rooms.append({"room_id": rid, "room_code": code, "dept_id": dept, "room_type": kind,
                           "capacity": CLASSROOM_CAPACITY if kind == "Classroom" else LAB_CAPACITY,
                           "building": self.buildings[dept]})
        self.rooms_by[(dept, kind)].append(rid)
        return rid

    # ---- faculty -----------------------------------------------------------------------
    def _candidates(self, u: Unit) -> list[int]:
        pool = [f for f in self.fac_by_dept[u.course_dept] if self.load[f] + u.hours <= self.cap[f]]
        noise = {f: rng.random() for f in pool}
        # balance load first; teaching a course already counts as a small head start, and
        # nobody picks up a fourth distinct course while others are available
        return sorted(pool, key=lambda f: (u.course_id not in self.courses_of[f] and len(self.courses_of[f]) >= 3,
                                           self.load[f] - (3 if u.course_id in self.courses_of[f] else 0),
                                           noise[f]))

    def _div_free(self, u: Unit, slot) -> bool:
        if u.offering_id is not None:
            return True
        used = self.div_busy[u.division_id].get(slot, set())
        return not used if u.batch_no is None else u.batch_no not in used

    def _commit(self, u: Unit, f: int, picks: list[tuple[int, int]], kind: str) -> None:
        home = (u.division_id, kind) if u.division_id is not None else None
        for day, start in picks:
            slots = [(day, start + k) for k in range(u.periods)]
            rid = self._room(u.room_dept, kind, slots, self.home_rooms[home] if home else [])
            if home and rid not in self.home_rooms[home]:
                self.home_rooms[home].append(rid)
            for s in slots:
                self.fac_busy[f].add(s)
                self.room_busy[rid].add(s)
                if u.division_id is not None:
                    occupied = {u.batch_no} if u.batch_no else set(range(1, self.n_batches[u.division_id] + 1))
                    self.div_busy[u.division_id][s] |= occupied
            u.entries.append((day, start, rid))
        u.faculty_id = f
        self.load[f] += u.hours
        self.courses_of[f].add(u.course_id)

    def place(self, u: Unit) -> None:
        kind = "Lab" if u.session_type == "Lab" else "Classroom"
        for f in self._candidates(u):
            picks = self._find_slots(u, f)
            if picks:
                self._commit(u, f, picks, kind)
                return
        raise RuntimeError(f"could not schedule course {u.course_id} div={u.division_id} "
                           f"batch={u.batch_id} offering={u.offering_id}")

    def _find_slots(self, u: Unit, f: int) -> list[tuple[int, int]] | None:
        if u.offering_id is not None:                       # honors: fixed reserved slots
            slots = HONORS_SLOTS[:u.weekly]
            return [s for s in slots] if all(s not in self.fac_busy[f] for s in slots) else None
        starts = LAB_START_PERIODS if u.periods == 2 else PERIODS
        days = list(DAYS)
        rng.shuffle(days)
        # prefer days on which this division is least busy, to spread its week
        days.sort(key=lambda d: sum(1 for (dd, _) in self.div_busy[u.division_id] if dd == d))
        picks = []
        for day in days:
            order = list(starts)
            rng.shuffle(order)
            for start in order:
                slots = [(day, start + k) for k in range(u.periods)]
                if all(self._div_free(u, s) and s not in self.fac_busy[f] for s in slots):
                    picks.append((day, start))
                    break
            if len(picks) == u.weekly:
                return picks
        return None


def schedule(units: list[Unit], faculty: pd.DataFrame, divisions, batches, departments_raw,
             offerings: pd.DataFrame, report: Report):
    buildings = {r.dept_id: r.office_room.rsplit("-", 1)[0] for r in departments_raw.itertuples()}
    sch = Scheduler(faculty, divisions, batches, buildings)
    # hardest first: honors (fixed slots), then labs (double periods), then most-frequent theory
    order = sorted(units, key=lambda u: (u.offering_id is None, u.session_type != "Lab", -u.weekly))
    for u in order:
        sch.place(u)

    assignments, entries = [], []
    for aid, u in enumerate(units, start=1):
        assignments.append({"assignment_id": aid, "academic_session_id": CURRENT_SESSION,
                            "course_id": u.course_id, "faculty_id": u.faculty_id,
                            "division_id": u.division_id, "batch_id": u.batch_id,
                            "offering_id": u.offering_id, "session_type": u.session_type,
                            "weekly_sessions": u.weekly})
        for day, start, rid in sorted(u.entries):
            entries.append({"assignment_id": aid, "day_of_week": day, "start_period": start,
                            "periods": u.periods, "room_id": rid})
    ta = pd.DataFrame(assignments).astype({"division_id": "Int64", "batch_id": "Int64", "offering_id": "Int64"})
    te = pd.DataFrame(entries)
    te.insert(0, "entry_id", range(1, len(te) + 1))

    # honors offerings take the faculty and room of their teaching unit
    hon = ta[ta.offering_id.notna()].set_index("offering_id").faculty_id
    offerings = offerings.copy()
    offerings["faculty_id"] = offerings.offering_id.map(hon)
    first_room = te.merge(ta[["assignment_id", "offering_id"]], on="assignment_id").dropna(subset=["offering_id"]) \
        .groupby("offering_id").room_id.first()
    offerings["room_id"] = offerings.offering_id.map(first_room)

    slots = pd.DataFrame([{"period_no": p, "start_time": s, "end_time": e} for p, (s, e) in PERIOD_TIMES.items()])
    rooms = pd.DataFrame(sch.rooms)
    loads = pd.Series(sch.load)
    report.section("Teaching assignments and timetable (generated)")
    report.item("Teaching assignments (division lectures, batch labs, honors sections)", len(ta))
    report.item("Weekly timetable entries", len(te))
    report.item("Rooms created on demand (classrooms + labs)", len(rooms))
    report.item(f"Faculty teaching load, hours/week: min {loads.min()}, median {int(loads.median())}, max {loads.max()}")
    report.note("Labs meet as one 2-period session per batch per week (G2 lists 0-0-3), matching the G3 data.")
    return ta, te, rooms, slots, offerings
