-- Flyway `beforeEachMigrate` callback: runs right before every versioned migration.
--
-- Flyway keeps its history table in the `flyway_history` schema (db/flyway.toml) and puts
-- that schema first on search_path while migrating. Migrations create their objects
-- unqualified and must create them in `public`, so pin search_path back to `public` for
-- the migration. Without this, V1 would build the whole schema inside flyway_history.
SET search_path = public;
