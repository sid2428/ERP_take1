# Platform / integration (T0)

## Shared UI kit (T0-1)

Authenticated admins can view `/admin/ui`. The page demonstrates reusable EJS partials in
`views/partials/` for stat tiles, sparklines, donut/ring charts, bar lists, timelines, and empty
states. The page is mounted inside the existing `requireLogin` + `requireRole('admin')` middleware.
Shared styles live in `public/css/app.css`; `tests/unit/ui-kit.test.ts` checks rendering, accessible
labels, escaping, and flat chart input.

## CI (T0-2)

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`: `npm ci`, typecheck, and the
database-independent unit-test directory. Branch protection is a repository-host setting and is
not configured by this workflow.

The placement role remains a proposal in `docs/work-assignments.md`; the work plan says it must be
confirmed before T7-3. Until that policy is accepted, placement remains under the existing admin
role and the `user_role` enum is unchanged.

## Releases and final verification (T0-3 / T0-4)

Local deliverables include the schema overview at `docs/schema/erp-er-diagram.md`, module data/rule
notes and demos under `docs/modules/`, and the cross-role walkthrough at `docs/evaluation-demo.md`.
Local test, build, audit and migration-history results belong in the completion report for each
release; these local artifacts are not evidence of a production check.

Supabase migration/seed/deploy, live-site role regression, branch-protection configuration,
credential maintenance and a current Supabase pause-state check remain external. They require the
appropriate owner credentials and live-site access. No production action is part of local
verification, and the placement role remains unapproved as described above.
