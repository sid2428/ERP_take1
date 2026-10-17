# Credentials (template)

The real file is **`CREDENTIALS.md`**. It is gitignored and must be shared privately (WhatsApp or a
private Drive link), **never committed**. This repository is public. Copy this template to
`CREDENTIALS.md` and fill it in.

## Live portal
| What | Value |
|---|---|
| URL | https://pict-erp-portal.vercel.app |
| Admin login | `admin` / `<password>` — full control, share only inside the team |
| Demo student | `STU202600004` / `<password>` |
| Demo faculty | `FAC-CSE-074` / `<password>` |
| Every other account | login = student number / faculty code; first password = date of birth / joining as DDMMYYYY |

## Option A — run the app locally against the shared database (SETUP.md)
| Variable | Value |
|---|---|
| `APP_DATABASE_URL` | `<postgres://erp_app.<project-ref>:<password>@<pooler-host>:6543/postgres>` |
| `DATABASE_SSL` | `true` |

## Supabase (database)
| What | Value |
|---|---|
| Dashboard | `https://supabase.com/dashboard/project/<project-ref>` |
| Project ref / region | `<ref>` / `<region>` |
| Owner connection (migrations, loads) | `<session-pooler URI with the database password>` |
| Database password | `<password>` (reset under Project Settings → Database) |
| App role (`erp_app`) password | `<password>` |

## Vercel (hosting)
| What | Value |
|---|---|
| Account / project | `<account>` / `pict-erp-portal` |
| Production env vars | `APP_DATABASE_URL`, `SESSION_SECRET` (stored only in Vercel) |

## Local development database (Docker)
| What | Value |
|---|---|
| Container / port | `erp-pg` / `54329` |
| `postgres` password | `<password>` |
| `erp_app` password | `<password>` |
