# Student experience (T1)

## Data and rules

The portal uses `student.student_id` as its internal identity and `student_number` as its login
identifier. `app_user.student_id` links a login to one student. Student routes derive that ID from
the authenticated session; client-supplied IDs do not select another student's records.

Current pages include the dashboard, curriculum, profile, attendance summary/detail, exams,
hall-ticket, results, fee/D-Wallet, electives, syllabus coverage and placement. Attendance is
read from the shared attendance views; exam and result data are filtered by the authenticated
student. Hall-ticket eligibility requires Registered status and at least 75% attendance.
Elective choices are saved in a transaction and audited. The database enforces the relevant
foreign keys, checks, attendance eligibility and elective-window rules in migrations 001–008,
041 and 084–089. Shared database contracts and exact enforcement are described in those migration
files and the T3–T6 module documents.

T1-3's certificate request/approval workflow, verifiable PDFs and digital certificate wallet are
not present in this checkout; the fee wallet is a separate T6 feature. No certificate decision
notification producer is wired because there is no authoritative certificate request table or
route.

## Demonstration

1. Sign in with a student demo account and open the dashboard, attendance detail, exams, results,
   fee page, electives and placement pages available in the selected fixture database.
2. Confirm attendance/result/fee records shown belong to that signed-in student. View an exam
   registration below 75% as ineligible if that fixture exists.
3. If an elective window is open, submit ranked choices and verify the saved state after reload.
4. Do not present certificate issuance as implemented; it remains a T1 acceptance gap.

Database and application coverage is in `tests/db/`, `tests/app/student-*`,
`tests/app/student-api.test.ts` and `tests/unit/`.
