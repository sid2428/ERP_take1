# G2 Master Dataset — CSV Export
**Module:** Academic & Course (Group 2) · **Source:** `university_erp` live database after full `06` seed + contract pass (18/18)
**Exported:** 15 Oct 2026 · **Encoding:** UTF-8 · **Delimiter:** comma · **NULLs:** empty cells · **Header row:** yes

## Master tables (exact DDL columns — safe to re-import)
| File | Rows | Contents |
|---|---:|---|
| `01_DEPARTMENT.csv` | 7 | engineering departments; `hod_faculty_id` links once G6 faculty exist |
| `02_PROGRAM.csv` | 14 | BTECH-\* + MTECH-\* (7 each), degree level, semesters, credits, intake |
| `03_COURSE.csv` | 182 | course catalog; types TH 147 / LAB 28 / TUT 7 |
| `04_COURSE_PREREQUISITE.csv` | 133 | dependency edges `(course_id, prereq_course_id)`, `min_grade` |
| `05_ACADEMIC_SESSION.csv` | 6 | term calendar; exactly one `is_current=1` (2026-ODD) |
| `06_PROGRAM_CURRICULUM.csv` | 223 | semester-wise placements; CORE 153 / PROF_ELECTIVE 28 / OPEN_ELECTIVE 42 |
| `07_COURSE_OFFERING_demo_sections.csv` | 1 | demo live section (G2 real offerings open during integration week) |

## Expanded views (names joined in — for reading/analysis, not import)
| File | Rows | Contents |
|---|---:|---|
| `V_COURSE_CATALOG.csv` | 182 | course + dept name + prereqs_needed + unlocks + #programs using it |
| `V_CURRICULUM.csv` | 223 | program + semester + course code/name/credits + category/basket + **own vs shared** flag |
| `V_PREREQUISITE_CHAINS.csv` | 133 | `CSE211 → requires → CSE111` style readable chains |
| `V_SHARED_COURSES.csv` | 11 | every course taught to >1 department (CSE111 → CSE+IT+AIDS, OE courses → 6 depts) |

## Quick facts
- Shared subjects keep **one identity** across departments (see `placement_kind` in V_CURRICULUM).
- Honors = `PROF_ELECTIVE` basket `H1`; open electives = `OPEN_ELECTIVE` basket `O1` placed cross-department.
- FK graph: PROGRAM.dept_id→DEPARTMENT · COURSE.dept_id→DEPARTMENT · COURSE_PREREQUISITE.a,b→COURSE · PROGRAM_CURRICULUM.program_id→PROGRAM, .course_id→COURSE · COURSE_OFFERING.course_id→COURSE, .session_id→ACADEMIC_SESSION.
- Rebuild the whole thing in seconds: `./install_g2.sh university_erp` (MySQL 8 / MariaDB).
- Full story: `G2_Evaluator_Walkthrough.md` · schema docs in `share/`.
