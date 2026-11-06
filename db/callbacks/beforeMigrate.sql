-- Flyway `beforeMigrate` callback: creates/updates the two runtime login roles BEFORE any
-- versioned migration runs (V1 references them in grants and policies). Idempotent; Flyway
-- runs it on every `flyway migrate`, as the schema owner (DATABASE_MIGRATOR_USER).
--
-- Passwords never reach this file in plaintext. db/docker-entrypoint.sh turns
-- DATABASE_APP_PASSWORD / DATABASE_WORKER_PASSWORD into SCRAM-SHA-256 verifiers
-- (db/tools/ScramVerifier.java) and hands Flyway only those, as placeholders:
--   appPasswordScram    <- FLYWAY_PLACEHOLDERS_APPPASSWORDSCRAM
--   workerPasswordScram <- FLYWAY_PLACEHOLDERS_WORKERPASSWORDSCRAM
-- PostgreSQL stores a pre-computed verifier as-is, so neither this statement's text nor
-- any server or Flyway log line about it (e.g. when the DO block fails) contains a
-- password. (Comments name the placeholders without placeholder syntax: Flyway
-- substitutes everywhere, including comments.)
--
-- A verifier consists of base64, `$` and `:` only, so a plain quoted literal is safe; it
-- still reaches CREATE/ALTER ROLE only through format('%L'). Anything that is not a
-- well-formed SCRAM-SHA-256 verifier (a missing placeholder, or a plaintext password
-- passed straight to Flyway) is refused, so plaintext can never be stored or logged here.
-- The DO body uses the tag `$bootstrap_roles$` because a verifier contains `$`.
--
--   lending_app    : used by the HTTP API. NOBYPASSRLS => every query is subject to
--                    Row-Level Security. No DDL rights.
--   lending_worker : used by the background worker (outbox relay, end-of-day jobs) and the
--                    platform module (institution registration). Also NOBYPASSRLS: its
--                    cross-tenant access is granted by an explicit `worker_all` policy on each
--                    table (see migrations). That keeps the privilege visible in the schema and
--                    avoids depending on the BYPASSRLS attribute, which managed Postgres (RDS)
--                    restricts for non-superusers.
DO $bootstrap_roles$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('lending_app',    '${appPasswordScram}'),
      ('lending_worker', '${workerPasswordScram}')
    ) AS v (name, verifier)
  LOOP
    IF r.verifier !~ '^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$' THEN
      RAISE EXCEPTION 'bootstrap password for % is not a SCRAM-SHA-256 verifier', r.name;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format(
        'CREATE ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
        r.name, r.verifier);
    ELSE
      -- Re-runs only rotate the password: a non-superuser owner (as on RDS) may not restate
      -- attributes in ALTER ROLE. Instead we VERIFY them and refuse to continue if a role has
      -- drifted into a privileged state.
      EXECUTE format('ALTER ROLE %I PASSWORD %L', r.name, r.verifier);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name
                 AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR NOT rolcanlogin)) THEN
        RAISE EXCEPTION 'role % has unexpected attributes (superuser/bypassrls/createrole/createdb/nologin)', r.name;
      END IF;
    END IF;
  END LOOP;
END
$bootstrap_roles$;
