-- 001 · Dedicated schema for every ERP object.
-- Supabase auto-exposes the `public` schema through its Data API; keeping the ERP in `erp`
-- (which the API does not serve) means only the app's own database connection can reach it.

CREATE SCHEMA IF NOT EXISTS erp;

-- btree_gist lets exclusion constraints mix = and && (timetable clashes). Supabase keeps
-- extensions in their own `extensions` schema; plain PostgreSQL uses `public`.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions';
  ELSE
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS btree_gist';
  END IF;
END $$;

-- On Supabase, make sure the API roles get nothing in this schema (no-op on plain PostgreSQL).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA erp FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA erp REVOKE ALL ON TABLES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA erp REVOKE ALL ON SEQUENCES FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA erp REVOKE ALL ON FUNCTIONS FROM anon, authenticated';
  END IF;
END $$;

-- Shared trigger function: keep updated_at current on every UPDATE.
CREATE OR REPLACE FUNCTION erp.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
