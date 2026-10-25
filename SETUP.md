# Setting up the PICT ERP Portal on your PC

This guide is written for **Windows 10/11** and uses **PowerShell** commands. On macOS or Linux, the
commands are the same except where noted.

There are two ways to run the project:

| | Option A — quick | Option B — full local setup |
|---|---|---|
| Time | ~5 minutes | ~45 minutes (20 of them are a one-time password-hashing step) |
| Needs | Node.js + `CREDENTIALS.md` from the team | Node.js, Python, Docker + the raw group CSV files |
| Database | the shared online Supabase database | your own PostgreSQL in Docker |
| Use it for | working on pages / UI | working on the schema, migrations, data pipeline, tests |

> **Option A uses the live production database.** Anything you change in the portal (courses,
> students, passwords) also changes on the live site. For experiments, use Option B.

---

## Step 1 · Install the tools (both options)

1. **Git**: https://git-scm.com/download/win (keep the defaults).
2. **Node.js 20 or newer** (LTS): https://nodejs.org. Then check:
   ```powershell
   node --version     # v20.x or higher
   npm --version
   ```
3. *(Option B only)* **Python 3.11+**: https://www.python.org/downloads/. Tick **"Add python.exe to PATH"**.
4. *(Option B only)* **Docker Desktop**: https://www.docker.com/products/docker-desktop/. Start it once and wait until it says *Engine running*.

## Step 2 · Get the code (both options)
```powershell
git clone https://github.com/sid2428/ERP_take1.git
cd ERP_take1
npm install
```

---

## Option A · Run against the shared online database

1. Get **`CREDENTIALS.md`** from the team lead (it is shared privately, never through GitHub).
2. Create a file named **`.env`** in the project folder with these three lines, copying the values from
   the *"Option A"* section of `CREDENTIALS.md`:
   ```ini
   APP_DATABASE_URL=<Supabase app connection string>
   DATABASE_SSL=true
   SESSION_SECRET=<any random text of 32+ characters>
   PORT=3100
   ```
   To make a random secret:
   `node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`
3. Start the app:
   ```powershell
   npm run dev
   ```
4. Open **http://localhost:3100** and sign in with a demo account from `CREDENTIALS.md`.

That's it. Skip to [Everyday use](#everyday-use).

---

## Option B · Full local setup

### B1 · Python packages
```powershell
pip install -r scripts/data/requirements.txt
```

### B2 · Put the raw group datasets in the project folder
The raw CSVs are about 250 MB, so they are **not** in Git. Get them from the team's shared folder and
copy these files into the **project root** (next to `package.json`), keeping their exact names:

| File | From |
|---|---|
| `01_DEPARTMENT.csv` … `07_COURSE_OFFERING_demo_sections.csv` | G2 (academic) |
| `students (3).csv` | G1 (students) |
| `attendance_divisions.csv`, `attendance_batches.csv`, `student_section_mapping.csv` | G3 (attendance) |
| `combined_student_fee_50000.csv` | fees (used from phase P4) |

They are already listed in `.gitignore`, so they can never be committed by accident.

### B3 · Start a local PostgreSQL database (Docker)
Pick any password for the local database (example: `localpass123`) and run:
```powershell
docker run -d --name erp-pg -e POSTGRES_PASSWORD=localpass123 -e POSTGRES_DB=erp `
  -p 54329:5432 -v erp-pg-data:/var/lib/postgresql/data postgres:17
```
(In Git Bash, macOS or Linux, use `\` instead of the backtick `` ` `` at the end of the first line.)

Check that it is running: `docker ps` should list **erp-pg**.

### B4 · Create your `.env` file
```powershell
Copy-Item .env.example .env
notepad .env
```
Fill it in like this (use your own values):
```ini
DATABASE_URL=postgres://postgres:localpass123@localhost:54329/erp
DATABASE_SSL=false

APP_DB_PASSWORD=<16+ random characters>
APP_DATABASE_URL=postgres://erp_app:<same APP_DB_PASSWORD>@127.0.0.1:54329/erp

SESSION_SECRET=<32+ random characters>
PORT=3100

DEMO_PASSWORD=<password you want for the demo student and faculty>
ADMIN_PASSWORD=<password you want for the admin account>
```
Generate random values with
`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
Use letters and digits only in `APP_DB_PASSWORD`, because it goes inside a URL.

### B5 · Build the data
```powershell
npm run data:build     # ~10 s: cleans and integrates the group data -> data/generated/
npm run data:users     # ~20 min, once: creates 50,431 login accounts with hashed passwords
```
`data:users` also writes **`data/generated/demo-credentials.txt`** with your demo logins.

### B6 · Create and fill the database
```powershell
npm run db:migrate        # creates the erp schema (migrations/*.sql)
npm run db:app-password   # sets the password of the app's least-privilege role
npm run db:load           # loads all tables (~20 s) and computes attendance totals
npm run db:verify         # 9 integrity checks + database size — all should say PASS
```

### B7 · Run the tests
```powershell
npm test                  # 48 tests: database rules, helpers and end-to-end pages
```

### B8 · Start the portal
```powershell
npm run dev
```
Open **http://localhost:3100** and sign in:

| Role | Login ID | Password |
|---|---|---|
| Student (demo) | `STU202600004` | your `DEMO_PASSWORD` |
| Faculty (demo) | `FAC-CSE-074` | your `DEMO_PASSWORD` |
| Admin | `admin` | your `ADMIN_PASSWORD` |
| Any other student / faculty | student number / faculty code | date of birth / date of joining as `DDMMYYYY` (you must change it at first sign-in) |

---

## Everyday use
```powershell
docker start erp-pg     # Option B only, after restarting the PC
npm run dev             # http://localhost:3100 — reloads automatically when you edit code
npm test                # before every commit
npm run typecheck
```
After pulling changes that add new files in `migrations/`, run `npm run db:migrate` again.

## Troubleshooting
| Problem | Fix |
|---|---|
| `Invalid environment configuration — APP_DATABASE_URL…` | `.env` is missing or incomplete (step A2 / B4). |
| `ECONNREFUSED 127.0.0.1:54329` | Docker Desktop is not running, or the container is stopped: `docker start erp-pg`. |
| `password authentication failed for user "erp_app"` | Run `npm run db:app-password` again; `APP_DB_PASSWORD` must match the password inside `APP_DATABASE_URL`. |
| Port 3100 already in use | Change `PORT=` in `.env` (for example 3200). |
| `data:build` cannot find a CSV | A raw file is missing from the project root or has a different name (step B2). |
| `migrate` says a migration "was changed after being applied" | Never edit an applied migration; add a new numbered file instead. To start over locally: `docker rm -f erp-pg; docker volume rm erp-pg-data`, then repeat from B3. |
| PowerShell blocks `npm` scripts | Run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. |
