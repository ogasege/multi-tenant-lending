-- Local Postgres bootstrap (runs ONCE, on an empty data volume, as the
-- container superuser via /docker-entrypoint-initdb.d).
--
-- Mirrors Amazon RDS: the schema owner `lending_owner` is NOT a superuser.
-- It only has CREATEROLE, which Flyway's beforeMigrate callback needs to create the
-- `lending_app` / `lending_worker` login roles (db/callbacks/beforeMigrate.sql).
-- Running migrations or the app as a superuser would silently bypass
-- Row-Level Security and hide tenant-isolation bugs.
--
-- The password comes from the container environment via psql's \getenv
-- (psql >= 15), so no secret is written into this file or the image.

\set ON_ERROR_STOP on

\getenv owner_password LENDING_OWNER_PASSWORD
\getenv db_name LENDING_DB_NAME
\getenv eu_db_name LENDING_EU_DB_NAME

-- Fail loudly (ON_ERROR_STOP) if the environment is incomplete.
\if :{?owner_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'LENDING_OWNER_PASSWORD is not set'; END $$;
\endif
\if :{?db_name}
\else
  DO $$ BEGIN RAISE EXCEPTION 'LENDING_DB_NAME is not set'; END $$;
\endif
\if :{?eu_db_name}
\else
  DO $$ BEGIN RAISE EXCEPTION 'LENDING_EU_DB_NAME is not set'; END $$;
\endif

CREATE ROLE lending_owner
  LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB CREATEROLE
  PASSWORD :'owner_password';

-- Primary (Lagos) cell database, plus the second cell's database used by
-- the `two-cells` compose profile. Login roles are cluster-wide in Postgres,
-- so both cells share lending_owner/lending_app/lending_worker locally; in
-- AWS each cell is a separate RDS instance with its own credentials.
CREATE DATABASE :"db_name" OWNER lending_owner;
CREATE DATABASE :"eu_db_name" OWNER lending_owner;

-- PG15+ already restricts CREATE on public to the database owner; make the
-- ownership explicit so the migrator owns every object it creates.
\connect :"db_name"
ALTER SCHEMA public OWNER TO lending_owner;

\connect :"eu_db_name"
ALTER SCHEMA public OWNER TO lending_owner;
