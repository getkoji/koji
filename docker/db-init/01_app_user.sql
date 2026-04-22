-- Provision the `app_user` Postgres role.
--
-- RLS is bypassed by any role with the BYPASSRLS attribute, including
-- every Postgres superuser. The API's runtime connection MUST use a
-- non-superuser role or the `FOR ALL` policies in 0001_rls.sql do
-- nothing. See packages/db/README.md "The Postgres role matters"
-- section for the full story.
--
-- This file runs via docker-entrypoint-initdb.d on FIRST boot of the
-- postgres image (i.e. when the pgdata volume is empty). For existing
-- volumes that skip this hook, the same role-provisioning SQL runs
-- inside `packages/db/src/migrate.ts` on every migrate invocation, so
-- the role is guaranteed to exist after the next API boot regardless
-- of how the DB was initialised.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_user' NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
