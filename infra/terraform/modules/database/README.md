# database

RDS PostgreSQL 16 (`engine_version = "16"`, so minor versions auto-upgrade with no plan drift), gp3 with storage
autoscaling, encrypted with a CMK, in private subnets only.

- **Parameter group:** `rds.force_ssl=1`, `ssl_min_protocol_version=TLSv1.2`, slow-query logging at 500 ms,
  connection, disconnection and lock-wait logging, `idle_in_transaction_session_timeout=60s`, and
  `pg_stat_statements`.
- **Master user:** `manage_master_user_password = true`. RDS generates and rotates the password in Secrets
  Manager under our CMK. Output `master_user_secret_arn` (keys `username` and `password`) is for the
  **migrations task only**.
- **Runtime roles** `lending_app` (RLS) and `lending_worker` (NOBYPASSRLS; cross-tenant only through the explicit `worker_all` RLS policy): their passwords come from
  `random_password` and are stored as `<name>/db/<role>` secrets. The migrations task applies them with
  the Flyway callback `db/callbacks/beforeMigrate.sql`. Terraform never connects to the database.
- **Resilience:** `multi_az`, `deletion_protection`, a final snapshot, `backup_retention_period`, and
  `delete_automated_backups = false`.
- **Observability:** Performance Insights (CMK, 7 days), 60 s Enhanced Monitoring, and `postgresql` and `upgrade`
  log exports into pre-created, KMS-encrypted log groups.
- **DR:** `enable_cross_region_backup_replication` replicates automated backups (snapshots and WAL) to
  `dr_region`, encrypted with a CMK created in `dr_region` through the AWS provider 6 `region` argument. Legal
  sign-off is required before replicating Nigerian payment data (see the root README).
- Ingress is allowed only from the security groups passed in `allowed_security_group_ids`.
