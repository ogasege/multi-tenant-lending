-- Flyway `afterMigrate` callback (runs after every successful `flyway migrate`, as the
-- schema owner). db/callbacks/afterMigrateError.sql repeats it for failed runs.
--
-- The history table lives in its own schema, `flyway_history` (db/flyway.toml), which the
-- runtime roles cannot even look into, so V1's `GRANT ... ON ALL TABLES IN SCHEMA public`
-- never reaches it. This revocation is belt and braces: whatever a future migration grants,
-- only the schema owner may read or rewrite migration history. Idempotent.
REVOKE ALL ON SCHEMA flyway_history FROM PUBLIC, lending_app, lending_worker;
REVOKE ALL ON TABLE flyway_history.flyway_schema_history FROM PUBLIC, lending_app, lending_worker;
