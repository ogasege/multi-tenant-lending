-- Flyway `afterMigrate` callback (runs after every `flyway migrate`, as the schema owner).
--
-- V1 grants DML on ALL TABLES IN SCHEMA public to the runtime roles, and Flyway creates
-- its history table in public before V1 runs, so that grant would let the API or worker
-- rewrite migration history. Only the schema owner may touch it. Idempotent.
REVOKE ALL ON TABLE flyway_schema_history FROM PUBLIC, lending_app, lending_worker;
