-- Flyway `afterMigrateError` callback: the same revocation as afterMigrate.sql, for runs
-- in which a migration FAILED. A failed migration is rolled back, but anything committed
-- before it (earlier migrations, history rows) stays; this guarantees the runtime roles
-- still have no access to migration history afterwards. Idempotent.
--
-- Conditional, because the failure may have happened before the roles or the history table
-- existed (e.g. in beforeMigrate on a fresh database); an error here would mask the real one.
DO $revoke_history$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['lending_app', 'lending_worker'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name);
    IF to_regnamespace('flyway_history') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON SCHEMA flyway_history FROM %I', role_name);
    END IF;
    IF to_regclass('flyway_history.flyway_schema_history') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE flyway_history.flyway_schema_history FROM %I', role_name);
    END IF;
  END LOOP;
  IF to_regnamespace('flyway_history') IS NOT NULL THEN
    REVOKE ALL ON SCHEMA flyway_history FROM PUBLIC;
  END IF;
  IF to_regclass('flyway_history.flyway_schema_history') IS NOT NULL THEN
    REVOKE ALL ON TABLE flyway_history.flyway_schema_history FROM PUBLIC;
  END IF;
END
$revoke_history$;
