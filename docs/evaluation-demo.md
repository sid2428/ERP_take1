# Evaluation demonstration script

Use a local database populated with synthetic demo rows and the intended current migrations. Select
existing demo accounts from the local credentials file; do not copy passwords into this document.
The script demonstrates product behavior only and is not evidence of a production/live-site test.

1. **Student:** show dashboard and profile, inspect attendance and exam results, and confirm fee
   and placement data belongs to the signed-in student. If an elective window is open, save choices.
2. **Faculty:** show assigned classes, record attendance or syllabus coverage, and enter permitted
   exam marks. Show that an over-maximum mark or a request outside the faculty assignment fails.
3. **Admin:** open the shared UI demonstration, review a grievance and notice, show the admin
   attendance-unlock queue, and inspect placement/academic management.
4. **Communication:** submit a grievance as a student; inspect its event notification in the admin
   inbox, then exercise an assignment/comment/status transition if the demo fixture supports it.
   Use an admin decision on a faculty leave request to demonstrate the T2 decision event.
5. **Fees:** show a synthetic successful payment receipt and wallet ledger only when the local
   gateway simulation is configured; never make a real charge.
6. **Security boundaries:** as a student, attempt one admin-only route and confirm 403; as one
   faculty member, request another faculty member's assignment and confirm denial.

The local database tests and route tests are the repeatable evidence for authorization and database
rules. Supabase readiness, branch protection, production deployment and live-site regression are
separate external checks and must be recorded only after an operator with the required access runs
them.
