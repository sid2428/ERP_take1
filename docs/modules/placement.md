# Training & Placement

The placement module provides student placement profiles, drive eligibility, applications, round outcomes, offers, and placement statistics. In the current version, placement management is restricted to the existing `admin` role; student actions are scoped to the authenticated student. Faculty can see only a read-only report for a department they head.

## Setup and routes

Apply the forward-only migrations against a verified local database with `npm run db:migrate`. Placement migrations `084`–`086` add the module, correct internship eligibility after an accepted full-time offer, and notify eligible students when a drive opens. Optional local-only demo data can be added with `npm run db:seed-placement`; the script refuses any target other than `localhost:54329/erp`. Do not use production credentials for local setup.

| User | Route | Capabilities |
| --- | --- | --- |
| Student | `/student/placement` | Summary and placement status |
| Student | `/student/placement/profile` | Edit skills and resume/profile links |
| Student | `/student/placement/drives` | Search, filter, and inspect eligibility |
| Student | `/student/placement/applications` | Review rounds, withdraw, and respond to offers |
| Admin | `/admin/placement` | Placement summary |
| Admin | `/admin/placement/companies` | Create, edit, activate, and deactivate companies |
| Admin | `/admin/placement/drives/new` | Create drives |
| Admin | `/admin/placement/drives/:id` | Manage status, rounds, applicants, results, and offers |
| Admin | `/admin/placement/statistics` | Aggregate statistics by department |
| Department HOD | `/faculty/placement` | Read-only report for their department |

All mutating endpoints use POST, the shared CSRF middleware, a transaction, and the existing audit log. No file uploads are supported; profile documents are links only. CSV exports quote cells and escape formula-leading content.

## Data model and lifecycle

Migration `084-placement.sql` adds `company`, `placement_drive`, `drive_program`, `drive_round`, `placement_application`, `round_result`, `placement_offer`, and `student_placement_profile`, plus the `v_student_placement_status` contract. Migration `085-placement-internship-eligibility.sql` leaves internship applications open after an accepted full-time offer while retaining the full-time compensation threshold. Migration `086-placement-notifications.sql` notifies eligible student accounts when an open drive is created or changed to Open; calls are deduplicated by student and drive link. Foreign keys retain company and drive history. Companies are deactivated instead of deleted.

Application transitions are `Applied → Shortlisted → Selected`, with `Rejected` or `Withdrawn` as terminal alternatives. Students can withdraw an `Applied` or `Shortlisted` application before that drive's deadline. A selected application can have one offer. Offer responses transition from `Pending` to `Accepted`, `Declined`, `Withdrawn`, or `Expired`; students may respond before the response deadline. Accepted full-time offers count toward placement; internships do not.

Eligibility uses current student program and current `student_section`/`division.year_of_study`, optional program allowlists, the existing current-session attendance view, drive dates, and the accepted full-time offer policy. Once a full-time offer is accepted, only full-time drives paying at least 1.5 times that accepted package remain eligible. A PostgreSQL transaction advisory lock serializes application and offer acceptance checks for the same student.

The repository does not currently publish `v_student_academic_standing`, CGPA, or active-backlog data. Drives requiring CGPA or backlog checks therefore return an unavailable-assessment reason and fail closed. These checks must be connected to the verified T5 contract before such drives are used. Attendance is assessed only when a minimum is set; unavailable attendance is also reported rather than assumed to pass.

`v_student_placement_status.applications` excludes withdrawn applications. `offers` counts every recorded offer regardless of response. `best_offer_lpa` uses accepted full-time offers only. `is_placed` is true when at least one full-time offer is accepted. Statistics count distinct students and offers to avoid round/application join inflation; the placement percentage uses active students as its denominator.

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

