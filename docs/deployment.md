# Data pipeline and deployment (technical reference)

For installing the project on your PC step by step, see [../SETUP.md](../SETUP.md).

## Prerequisites
- Node.js 20+ and Python 3.11+ (`pip install -r scripts/data/requirements.txt`)
- Docker Desktop (local PostgreSQL 17)
- The group CSV files at the repository root (gitignored because of their size)

## 1. Build the dataset (deterministic, fixed random seed)
```bash
npm install
npm run data:build     # -> data/generated/*.csv + data/reports/data-cleanup-report.md   (~10 s)
npm run data:users     # -> data/generated/app_user.csv (50,431 accounts, scrypt hashes) (~20 min, once)
```
`data:users` also writes `data/generated/demo-credentials.txt` (gitignored) with the demo logins.

## 2. Local database and app
```bash
docker run -d --name erp-pg -e POSTGRES_PASSWORD=<choose-one> -e POSTGRES_DB=erp \
  -p 54329:5432 -v erp-pg-data:/var/lib/postgresql/data postgres:17
cp .env.example .env       # fill in the passwords and secrets
npm run db:migrate         # migrations/*.sql
npm run db:app-password    # password for the least-privilege erp_app role
npm run db:load            # COPY every table (~20 s), then compute attendance totals
npm run db:verify          # integrity checks + size report
npm test                   # database rules, helpers and end-to-end HTTP tests
npm run dev                # http://localhost:3100
```

## 3. Supabase (production database)
1. Dashboard → **Connect** → **Session pooler** → copy the URI into `.env.supabase` as `DATABASE_URL`.
2. Add `APP_DB_PASSWORD=<long random value>` and `DATABASE_SSL=true` to `.env.supabase`.
3. Run:
```bash
npm run supabase:check         # read-only connection check
npm run supabase:migrate
npm run supabase:app-password
npm run supabase:load          # ~2.5 min over the network
npm run supabase:verify
npm run supabase:app-url       # tests erp_app via the transaction pooler; writes APP_DATABASE_URL
```
All ERP objects live in the `erp` schema, which Supabase's REST API does not expose. The app's
`erp_app` role can read and write data, but it cannot change the schema.

## 4. Vercel (web app)
Live deployment: **https://pict-erp-portal.vercel.app**

`vercel.json` builds the TypeScript (`npm run build`), routes every request to `api/index.js`
(the Express app) and runs it in Tokyo (`hnd1`), next to the Supabase database. `"framework": null`
is required: otherwise Vercel applies its Express preset and ignores `api/`. `.vercelignore`
keeps the datasets, pipeline and tests out of the upload.

Environment variables (Production):

| Name | Value |
|---|---|
| `APP_DATABASE_URL` | from `.env.supabase` (written by `supabase:app-url`) |
| `SESSION_SECRET` | a new random value of 32+ characters |

```bash
npx vercel login
npx vercel link --yes --project pict-erp-portal
npx vercel env add APP_DATABASE_URL production
npx vercel env add SESSION_SECRET production
npx vercel deploy --prod
```

## Pipeline overview
| Step | Script | Source |
|---|---|---|
| Academic structure | `scripts/data/academic.py` | G2 CSVs (source of truth) |
| Students (cleaned) | `scripts/data/people.py` | `students (3).csv` |
| Divisions, batches, enrollment | `scripts/data/sections.py` | G3 section files + G2 curriculum |
| Faculty, rooms, timetable | `scripts/data/timetable.py` | generated (G6 data unavailable) |
| Attendance | `scripts/data/attendance.py` | regenerated using G3's presence model |
| Accounts | `scripts/db/build-users.ts` | one per student/faculty, plus admin |
