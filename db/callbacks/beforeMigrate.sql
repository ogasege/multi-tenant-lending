-- Flyway `beforeMigrate` callback: creates/updates the two runtime login roles BEFORE any
-- versioned migration runs (V1 references them in grants and policies). Idempotent; Flyway
-- runs it on every `flyway migrate`, as the schema owner (DATABASE_MIGRATOR_USER).
--
-- Secrets never appear in this file or in any SQL text sent to the server:
--   * db/docker-entrypoint.sh turns DATABASE_APP_PASSWORD / DATABASE_WORKER_PASSWORD into
--     SCRAM-SHA-256 verifiers (db/tools/ScramVerifier.java), so no plaintext password exists
--     beyond the entrypoint;
--   * the verifiers travel out of band, as session settings in the JDBC connection's startup
--     `options` (`-c bootstrap.app_scram=... -c bootstrap.worker_scram=...`). They are read
--     here with current_setting(); Flyway does no placeholder substitution at all;
--   * the only statements that carry a verifier are the dynamic CREATE/ALTER ROLE below.
--     PL/pgSQL EXECUTE is not logged by log_statement, and any error from it is caught and
--     re-raised WITHOUT the statement text, so a failure cannot log the verifier either
--     (an uncaught error would show the statement in the CONTEXT line).
--
-- PostgreSQL stores a pre-computed verifier as-is. Anything that is not a well-formed
-- SCRAM-SHA-256 verifier (setting missing, or a plaintext password) is refused.
--
--   lending_app    : used by the HTTP API. NOBYPASSRLS => every query is subject to
--                    Row-Level Security. No DDL rights.
--   lending_worker : used by the background worker (outbox relay, end-of-day jobs) and the
--                    platform module (institution registration). Also NOBYPASSRLS: its
--                    cross-tenant access is granted by an explicit `worker_all` policy on each
--                    table (see migrations). That keeps the privilege visible in the schema and
--                    avoids depending on the BYPASSRLS attribute, which managed Postgres (RDS)
--                    restricts for non-superusers.
-- Refuse databases migrated with the earlier layout (history table in `public`). Flyway's
-- own non-empty-schema guard does not fire here, because it has just created the empty
-- flyway_history schema; without this check V1 would fail half-way with a confusing error.
DO $layout_guard$
BEGIN
  IF to_regclass('public.flyway_schema_history') IS NOT NULL THEN
    RAISE EXCEPTION 'migration history found in public.flyway_schema_history (old layout); '
      'it now lives in flyway_history. Recreate the database (locally: make clean)';
  END IF;
END
$layout_guard$;

DO $bootstrap_roles$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('lending_app',    current_setting('bootstrap.app_scram', true)),
      ('lending_worker', current_setting('bootstrap.worker_scram', true))
    ) AS v (name, verifier)
  LOOP
    IF coalesce(r.verifier, '') !~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$' THEN
      RAISE EXCEPTION 'bootstrap password for % is missing or not a SCRAM-SHA-256 verifier', r.name;
    END IF;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
        EXECUTE format(
          'CREATE ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
          r.name, r.verifier);
      ELSE
        -- Re-runs only rotate the password: a non-superuser owner (as on RDS) may not restate
        -- attributes in ALTER ROLE. The attributes are VERIFIED below instead.
        EXECUTE format('ALTER ROLE %I PASSWORD %L', r.name, r.verifier);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Re-raise with the original SQLSTATE and message but without the statement text.
      RAISE EXCEPTION 'creating/rotating role % failed: %', r.name, SQLERRM
        USING ERRCODE = SQLSTATE;
    END;
    -- Refuse to continue if a role has drifted into a privileged state.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name
               AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR NOT rolcanlogin)) THEN
      RAISE EXCEPTION 'role % has unexpected attributes (superuser/bypassrls/createrole/createdb/nologin)', r.name;
    END IF;
  END LOOP;
END
$bootstrap_roles$;

-- The verifiers are not needed beyond this point: clear them from the session, so later
-- migrations on this connection cannot read them. (Not RESET: that would restore the
-- connection-startup value, i.e. the verifier itself.)
SET bootstrap.app_scram = '';
SET bootstrap.worker_scram = '';
