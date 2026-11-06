locals {
  id = "${var.name}-valkey"
}

resource "aws_security_group" "this" {
  name        = local.id
  description = "Valkey access for ${var.name} workloads"
  vpc_id      = var.vpc_id

  tags = {
    Name = local.id
  }
}

resource "aws_vpc_security_group_ingress_rule" "valkey" {
  for_each = var.allowed_security_group_ids

  security_group_id            = aws_security_group.this.id
  description                  = "Valkey from ${each.key}"
  referenced_security_group_id = each.value
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_elasticache_subnet_group" "this" {
  name        = local.id
  description = "Isolated subnets for ${local.id}"
  subnet_ids  = var.subnet_ids
}

resource "aws_cloudwatch_log_group" "slow_log" {
  name              = "/aws/elasticache/${local.id}/slow-log"
  retention_in_days = var.log_retention_in_days
  kms_key_id        = var.logs_kms_key_arn
}

# AUTH token: 64 alphanumerics (ElastiCache allows 16-128 printable
# chars but forbids @, " and /; alphanumerics sidestep URL escaping in
# REDIS_URL entirely).
resource "random_password" "auth_token" {
  length  = 64
  special = false
}

# Valkey rather than Redis OSS: wire-compatible with ioredis, Linux
# Foundation licensed, and ElastiCache prices Valkey ~20% below Redis OSS.
resource "aws_elasticache_replication_group" "this" {
  replication_group_id = local.id
  description          = "Rate limiting, idempotency fast-path and branding cache for ${var.name}"
  engine               = "valkey"
  engine_version       = var.engine_version
  node_type            = var.node_type
  port                 = 6379

  # Cluster mode disabled: the working set is small and ioredis with a
  # single primary endpoint keeps Lua/MULTI rate-limit scripts simple.
  num_cache_clusters         = var.num_cache_clusters
  automatic_failover_enabled = var.automatic_failover_enabled
  multi_az_enabled           = var.automatic_failover_enabled

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = [aws_security_group.this.id]

  # TLS required (not "preferred"): plaintext clients are refused.
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = random_password.auth_token.result
  # ROTATE keeps old+new tokens valid during a token change so running
  # tasks are not disconnected mid-deploy.
  auth_token_update_strategy = "ROTATE"

  at_rest_encryption_enabled = true
  kms_key_id                 = var.kms_key_arn

  snapshot_retention_limit   = var.snapshot_retention_limit
  snapshot_window            = "00:00-01:00"
  maintenance_window         = "sun:03:30-sun:04:30"
  auto_minor_version_upgrade = true
  apply_immediately          = false

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.slow_log.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }

  tags = {
    Name = local.id
  }
}

resource "aws_secretsmanager_secret" "this" {
  #checkov:skip=CKV2_AWS_57:AUTH rotation is a ROTATE-strategy apply, not a Lambda; documented runbook
  name                    = "${var.name}/redis"
  description             = "Valkey AUTH token and full REDIS_URL for ${local.id}"
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = var.secret_recovery_window_in_days
}

# The whole URL is the secret (it embeds the token), so the app gets a
# single REDIS_URL from Secrets Manager via the JSON key "url".
resource "aws_secretsmanager_secret_version" "this" {
  secret_id = aws_secretsmanager_secret.this.id
  secret_string = jsonencode({
    auth_token = random_password.auth_token.result
    url        = "rediss://:${random_password.auth_token.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
  })
}
