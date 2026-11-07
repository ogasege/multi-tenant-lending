locals {
  identifier = "${var.name}-postgres"

  # Runtime login roles. The passwords are generated here (ephemeral,
  # never in state), written to Secrets Manager, and applied to the
  # database by the migrations task (Flyway callback
  # db/callbacks/beforeMigrate.sql) - Terraform never connects to
  # Postgres, so no DB provider or network path from CI into the VPC is
  # needed.
  db_roles = {
    app    = var.app_role_name
    worker = var.worker_role_name
  }
}

# ---------------------------------------------------------------------
# Network access
# ---------------------------------------------------------------------

resource "aws_security_group" "this" {
  name        = local.identifier
  description = "PostgreSQL access for ${var.name} workloads"
  vpc_id      = var.vpc_id

  tags = {
    Name = local.identifier
  }
}

# Ingress only from named workload SGs (never CIDRs): moving a task to a
# new subnet cannot widen access, and every allowed caller is explicit.
resource "aws_vpc_security_group_ingress_rule" "postgres" {
  for_each = var.allowed_security_group_ids

  security_group_id            = aws_security_group.this.id
  description                  = "PostgreSQL from ${each.key}"
  referenced_security_group_id = each.value
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# ---------------------------------------------------------------------
# Parameter group
# ---------------------------------------------------------------------

resource "aws_db_parameter_group" "this" {
  name        = local.identifier
  family      = "postgres16"
  description = "Hardened parameters for ${local.identifier}"

  # Reject any non-TLS connection server-side; DATABASE_SSL=true in the
  # app is then a requirement, not a hope.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # TLS 1.2 floor for client connections.
  parameter {
    name  = "ssl_min_protocol_version"
    value = "TLSv1.2"
  }

  # Log statements slower than 500 ms - cheap, high-signal tuning input.
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }

  # Connection audit trail (who connected as which role, from where).
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  # Lock waits are the first symptom of the FOR UPDATE contention the
  # disburse/repay paths rely on; log anything waiting > deadlock_timeout.
  parameter {
    name  = "log_lock_waits"
    value = "1"
  }

  # Kill sessions that sit "idle in transaction" holding row locks.
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------
# Enhanced Monitoring role
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "monitoring_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  name                 = "${local.identifier}-monitoring"
  assume_role_policy   = data.aws_iam_policy_document.monitoring_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  role       = aws_iam_role.monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# Pre-create the export log groups so they get our retention and CMK
# (RDS would otherwise create them unencrypted with infinite retention).
resource "aws_cloudwatch_log_group" "postgres" {
  for_each = toset(["postgresql", "upgrade"])

  name              = "/aws/rds/instance/${local.identifier}/${each.key}"
  retention_in_days = var.log_retention_in_days
  kms_key_id        = var.logs_kms_key_arn
}

# ---------------------------------------------------------------------
# Instance
# ---------------------------------------------------------------------

resource "aws_db_instance" "this" {
  identifier     = local.identifier
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class
  db_name        = var.database_name

  # gp3: baseline 3000 IOPS / 125 MiB/s independent of size, cheaper than
  # gp2 at small sizes. Autoscaling avoids a 3 a.m. storage-full outage.
  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_encrypted     = true
  kms_key_id            = var.rds_kms_key_arn

  # RDS generates the master password, stores it in Secrets Manager
  # (encrypted with our CMK) and rotates it every 7 days. The password
  # never appears in Terraform state or variables.
  username                      = var.master_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.secrets_kms_key_arn

  # IAM auth enabled for break-glass human access with short-lived
  # tokens; workloads use password roles from Secrets Manager.
  iam_database_authentication_enabled = true

  db_subnet_group_name   = var.db_subnet_group_name
  vpc_security_group_ids = [aws_security_group.this.id]
  publicly_accessible    = false
  port                   = 5432
  network_type           = "IPV4"

  parameter_group_name = aws_db_parameter_group.this.name
  multi_az             = var.multi_az

  # Backups: PITR window, plus tags copied so snapshots stay attributable.
  backup_retention_period  = var.backup_retention_period
  backup_window            = "01:00-02:00" # UTC = 02:00-03:00 WAT, lowest traffic
  maintenance_window       = "sun:02:30-sun:03:30"
  copy_tags_to_snapshot    = true
  delete_automated_backups = false # keep backups if the instance is deleted
  skip_final_snapshot      = var.skip_final_snapshot
  final_snapshot_identifier = (
    var.skip_final_snapshot ? null : "${local.identifier}-final"
  )
  deletion_protection = var.deletion_protection

  # Minor versions carry security fixes; apply them in the window.
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = false

  # Observability: Performance Insights (7 days free tier, CMK) and
  # 60s Enhanced Monitoring for OS-level metrics.
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.rds_kms_key_arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  tags = {
    Name = local.identifier
  }

  depends_on = [aws_cloudwatch_log_group.postgres]
}

# ---------------------------------------------------------------------
# Cross-region backup replication (DR)
# ---------------------------------------------------------------------

# A CMK in the DR region: KMS keys are regional, so replicated backups
# must be re-encrypted with a key that lives where they land.
resource "aws_kms_key" "dr" {
  #checkov:skip=CKV2_AWS_64:Default key policy (root delegation) is intended; access is granted via IAM
  count = var.enable_cross_region_backup_replication ? 1 : 0

  region                  = var.dr_region
  description             = "${local.identifier}: replicated RDS automated backups (DR)"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  rotation_period_in_days = 365
}

resource "aws_kms_alias" "dr" {
  count = var.enable_cross_region_backup_replication ? 1 : 0

  region        = var.dr_region
  name          = "alias/${local.identifier}-dr"
  target_key_id = aws_kms_key.dr[0].key_id
}

# Replicates snapshots AND transaction logs, so the DR region can do a
# point-in-time restore (RPO ~ minutes) rather than only "last nightly
# snapshot". Uses the AWS provider 6 per-resource `region` argument
# instead of a second aliased provider.
resource "aws_db_instance_automated_backups_replication" "dr" {
  count = var.enable_cross_region_backup_replication ? 1 : 0

  region                 = var.dr_region
  source_db_instance_arn = aws_db_instance.this.arn
  kms_key_id             = aws_kms_key.dr[0].arn
  retention_period       = var.dr_backup_retention_period
}

# ---------------------------------------------------------------------
# Runtime role credentials (lending_app, lending_worker)
# ---------------------------------------------------------------------

# Ephemeral (Terraform >= 1.11): the password exists only in memory for
# the run that writes it and never reaches plan or state. A new value is
# generated on every run, but it is only WRITTEN when
# role_password_version changes (or the secret version is created), so
# steady-state applies are no-ops.
# special = false: avoids URL/connection-string escaping bugs; 40 chars
# of [A-Za-z0-9] is still ~238 bits of entropy.
ephemeral "random_password" "role" {
  for_each = local.db_roles

  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "role" {
  # Rotation needs a Lambda that ALTER ROLEs and a dual-password window;
  # tasks only read secrets at start-up. Planned follow-up (README).
  #checkov:skip=CKV2_AWS_57:Rotation requires rotation Lambda + app reconnect support; planned
  for_each = local.db_roles

  name                    = "${var.name}/db/${each.value}"
  description             = "PostgreSQL login for role ${each.value}"
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_in_days
}

# Write-only: secret_string_wo is sent to Secrets Manager and discarded;
# state holds only the version number. Only the password is stored: host
# and port reach tasks as plain environment variables (DATABASE_HOST),
# and keeping them here would go stale because write-only values are not
# re-sent unless the version changes.
# Rotation: bump role_password_version. The pipeline writes the secret
# (targeted apply) BEFORE running migrations, and the Flyway beforeMigrate
# callback ALTERs the roles to the new value, so Postgres follows.
resource "aws_secretsmanager_secret_version" "role" {
  for_each = local.db_roles

  secret_id = aws_secretsmanager_secret.role[each.key].id
  secret_string_wo = jsonencode({
    username = each.value
    password = ephemeral.random_password.role[each.key].result
  })
  secret_string_wo_version = var.role_password_version
}
