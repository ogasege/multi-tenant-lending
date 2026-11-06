-- Creates/updates the two runtime login roles. Idempotent; executed by the migration runner
-- (as the schema owner) BEFORE migrations. Passwords are passed in as transaction-local
-- settings (never interpolated by the application), see src/common/database/migrate.ts.
--
--   lending_app    : used by the HTTP API. NOBYPASSRLS => every query is subject to
--                    Row-Level Security. No DDL rights.
--   lending_worker : used by the background worker (outbox relay, end-of-day jobs) and the
--                    platform module (institution registration). Also NOBYPASSRLS: its
--                    cross-tenant access is granted by an explicit `worker_all` policy on each
--                    table (see migrations). That keeps the privilege visible in the schema and
--                    avoids depending on the BYPASSRLS attribute, which managed Postgres (RDS)
--                    restricts for non-superusers.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('lending_app',    current_setting('bootstrap.app_password', true)),
      ('lending_worker', current_setting('bootstrap.worker_password', true))
    ) AS v (name, password)
  LOOP
    IF coalesce(r.password, '') = '' THEN
      RAISE EXCEPTION 'bootstrap password for % not provided', r.name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
        r.name, r.password);
    ELSE
      -- Re-runs only rotate the password: a non-superuser owner (as on RDS) may not restate
      -- attributes in ALTER ROLE. Instead we VERIFY them and refuse to continue if a role has
      -- drifted into a privileged state.
      EXECUTE format('ALTER ROLE %I PASSWORD %L', r.name, r.password);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name
                 AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR NOT rolcanlogin)) THEN
        RAISE EXCEPTION 'role % has unexpected attributes (superuser/bypassrls/createrole/createdb/nologin)', r.name;
      END IF;
    END IF;
  END LOOP;
END
$$;
