# Training & Placement

The placement module provides student placement profiles, drive eligibility, applications, round outcomes, offers, and placement statistics. In the current version, placement management is restricted to the existing `admin` role; student actions are scoped to the authenticated student. Faculty can see only a read-only report for a department they head.

## Setup and routes

Apply forward-only migrations only after confirming the database target and reviewing every pending migration. The runner `npm run db:migrate` applies all pending migrations in filename order, each in its own transaction; it cannot select one migration. Placement migrations `084`–`086` add the module, correct internship eligibility after an accepted full-time offer, and notify eligible students when a drive opens. Migration `090` enforces drive and recruitment-round state transitions and prevents newly scheduled or rescheduled rounds from being placed in the past. Migration `091` fixes row assignment in the drive notification procedure. Migration `092` adds the drive/application/offer summary view. Migration `099` adds a nullable, explicitly maintained expected graduation year; it deliberately does not backfill existing students. Migration `100` adds a separate nullable student-submission field and index; it does not change verified years or statistics. Optional local-only demo data can be added with `npm run db:seed-placement`; the script refuses any target other than `localhost:54329/erp`. Never point local scripts at Supabase or production.

| User | Route | Capabilities |
| --- | --- | --- |
| Student | `/student/placement` | Summary and placement status |
| Student | `/student/placement/profile` | Edit skills and resume/profile links; optionally submit an expected passing-out year |
| Administrator | `/admin/students/expected-graduation-year-submissions` | Verify or reject student-submitted expected passing-out years |
| Student | `/student/placement/drives` | Search, filter, inspect eligibility, and browse paginated results |
| Student | `/student/placement/applications` | Review rounds, withdraw, and respond to offers |
| Admin | `/admin/placement` | Placement summary |
| Admin | `/admin/placement/companies` | Create, edit, activate, and deactivate companies |
| Admin | `/admin/placement/drives/new` | Create drives |
| Admin | `/admin/placement/drives/:id` | Manage status, round schedules and states, applicants, results, and offers |
| Admin | `/admin/placement/drives/:id/edit` | Edit Draft drives before publication |
| Admin | `/admin/placement/statistics` | Branch- and verified passing-out-batch statistics with combined filters |
| Admin | `/admin/students/:id?edit=1` | View verified expected passing-out year; it cannot be changed through the general student editor |
| Department HOD | `/faculty/placement` | Read-only report for their department |

All mutating endpoints use POST, the shared CSRF middleware, a transaction, and the existing audit log. No file uploads are supported; profile documents are links only. CSV exports quote cells and escape formula-leading content.

Drive details can be edited only while a drive is Draft and has no applications. Published (Open), Closed, and Cancelled drives cannot be edited or moved back to Draft; this preserves advertised criteria and prevents editing from bypassing publication history. Drive transitions are `Draft → Open → Closed`, with cancellation allowed from Draft or Open; Closed and Cancelled are terminal. Recruitment rounds can be rescheduled while Planned or In Progress; a changed schedule must be in the future. Round transitions are `Planned → InProgress → Completed`, with cancellation allowed from Planned or InProgress. Completed and Cancelled rounds are terminal.

Student drive searches are counted and paginated in PostgreSQL. The page size defaults to 20 and is capped at 50; search, drive type, and eligibility filters are retained when moving between pages. A requested page beyond the result range is clamped to the last available page, and empty results display an explicit empty state.

## Data model and lifecycle

Migration `084-placement.sql` adds `company`, `placement_drive`, `drive_program`, `drive_round`, `placement_application`, `round_result`, `placement_offer`, and `student_placement_profile`, plus the `v_student_placement_status` contract. Migration `085-placement-internship-eligibility.sql` leaves internship applications open after an accepted full-time offer while retaining the full-time compensation threshold. Migration `086-placement-notifications.sql` notifies eligible student accounts when an open drive is created or changed to Open; calls are deduplicated by student and drive link. Foreign keys retain company and drive history. Companies are deactivated instead of deleted.

Application transitions are `Applied → Shortlisted → Selected`, with `Rejected` or `Withdrawn` as terminal alternatives. Students can withdraw an `Applied` or `Shortlisted` application before that drive's deadline. A selected application can have one offer. Offer responses transition from `Pending` to `Accepted`, `Declined`, `Withdrawn`, or `Expired`; students may respond before the response deadline. Accepted full-time offers count toward placement; internships do not.

Eligibility uses current student program and current `student_section`/`division.year_of_study`, optional program allowlists, the existing current-session attendance view, drive dates, and the accepted full-time offer policy. Once a full-time offer is accepted, only full-time drives paying at least 1.5 times that accepted package remain eligible. A PostgreSQL transaction advisory lock serializes application and offer acceptance checks for the same student.

The examination module defines `student_cgpa` from final course results, but the verified local database currently has not applied `084-group3-examination.sql`, `085-group3-exam-logic.sql`, `086-attendance-extra-sessions.sql`, `087-attendance-unlocks.sql`, `088-course-marks-scheme.sql`, or `089-refresh-exam-results.sql`; `erp.student_cgpa` is absent there. Placement therefore does not treat unseen academic data as zero or as a pass: CGPA/backlog requirements return an unavailable-assessment reason and fail closed. Connect these criteria only after the examination source and refresh migrations are applied and verified. Attendance is assessed only when a minimum is set; unavailable attendance is also reported rather than assumed to pass.

`v_student_placement_status.applications` excludes withdrawn applications. `offers` counts every recorded offer regardless of response. `best_offer_lpa` uses accepted full-time offers only. `is_placed` is true when at least one full-time offer is accepted. Statistics count distinct students and offers to avoid round/application join inflation; the placement percentage uses active students as its denominator. The admin report shows highest, median and average accepted full-time package, accepted full-time/internship totals, branch placement rates, batch placement rates, and company offer totals with accepted offer breakdowns.

### Expected passing-out year and batch statistics

A batch is the student's expected graduation/passing-out year explicitly recorded in `student.expected_graduation_year`, not admission year, current academic session, program duration, or actual graduation status. Migration `099-student-expected-graduation-year.sql` adds the nullable verified `smallint` field with a 2000–2100 constraint. Migration `100-student-expected-graduation-year-submissions.sql` adds a separate nullable field for student submissions; it does not populate existing records. No year is inferred or backfilled. Students may submit a year from their TNP profile, but that value remains pending and is excluded from all cohort analytics until an administrator verifies it against an authoritative institutional record. Verification requires a short source description or institutional record reference, which is stored in the audit event; do not upload or enter sensitive documents or details. Admins can review pending values at `/admin/students/expected-graduation-year-submissions`; general student edits cannot change the verified year. Verification, rejection, and student submission changes are audited with the actor, decision, and old/new values.

The statistics page's branch and passing-out-year filters can be used independently or together. An empty filter means all branches or all batches. A requested branch or year that is malformed or unavailable returns HTTP 400 rather than widening the report. The batch dropdown lists years currently held by active students in the selected branch scope.

Batch denominators include active students with that recorded year only. Placed students are distinct active students with at least one accepted full-time offer; accepted internships do not qualify. Total recorded offers count every offer status for students in the selected branch/year scope. Accepted full-time and internship offers are counted separately. Highest, average, median, and package bands use accepted full-time offers with a recorded package; missing package values are omitted from package calculations, but accepted-offer counts still include them. Active students without a recorded expected year are reported separately at branch/institution scope and are never assigned to a batch.

Cohort completeness depends on administrators maintaining verified values. Until records are reviewed and entered, batch statistics represent only the known-year subset and must not be interpreted as a complete graduating class.

### Safe release sequence

1. Review the current diff and run focused unit tests, workflow tests against an isolated database, typecheck, and production builds.
2. Before any database change, confirm the exact host, port, and database name. Review the complete pending migration list and effects; this runner applies the entire pending set.
3. Back up the target database and obtain explicit change approval before running migrations. Apply migrations before deploying code that reads the new submission column. Do not apply local migration commands to Supabase or production.
4. After migration, verify the migration ledger/checksum, new column constraints/index, and no existing student years changed. Then run authenticated student submission and admin review checks with approved test accounts.
5. Deploy only through the separately approved deployment workflow; this module documentation does not authorize or perform deployment.

## Dependencies and limitations

- There is no dedicated placement officer role in the current application role union, so administration is limited to admins.

- `db:seed-placement` adds 40 synthetic companies, 60 open drives, and eligible synthetic applications, rounds, results, and offers using existing local student records. It does not invent academic standing or attendance records.
- The student-facing dashboard and admin/faculty reports are read from the local ERP schema. Apply the migration before starting the app with these routes.

## Demonstration

1. Sign in as an admin and open **Placement → Companies**; add or select a synthetic company.
2. Create a full-time or internship drive. Leave CGPA/backlog criteria blank until the T5 academic-standing view is available; set programs, study year, and an active deadline.
3. Sign in as a student whose current program/year matches the drive. Open **Placement → Drives**, review eligibility, and apply.
4. As admin, open the drive, add rounds, and change the application to Shortlisted then Selected. Record a round result and create an offer with compensation matching the drive type.
5. As the same student, open **My applications** and accept or decline before the response deadline.
6. Review placement status and statistics. A full-time accepted offer marks the student placed; an internship does not.
7. Review the Admin audit log for the corresponding placement actions.

Database tests are in `tests/db/placement.test.ts`. Run `npm run typecheck` and `npm test` after the migration is applied to a local development database.

The admin statistics page defines overall and branch placement percentage as active students with an accepted full-time offer divided by active students in the selected scope; a zero denominator displays 0%. Branch figures follow `student.program_id` to `program.dept_id`. Offer totals count offers separately from distinct placed students. Package averages and distribution use accepted full-time offers with a nonmissing package; chart bands are `<5`, `5–<10`, `10–<15`, `15–<20`, and `20+` LPA. Batch figures include only students with an explicitly maintained expected graduation year; unknown-year students are reported separately and excluded from batch denominators.
