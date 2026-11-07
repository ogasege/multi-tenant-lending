# LocalStack target for integration tests and docker-compose. NOT a
# deployment environment: it codifies only the AWS services the app
# talks to (S3, SQS + DLQ, KMS, Secrets Manager) and reuses the real
# messaging and storage modules, so local behaviour (DLQ redrive after 5
# receives, tenant-prefix-only writes, SSE-KMS) matches the cloud.
# State is local (terraform.tfstate, git-ignored): it is disposable.

resource "aws_kms_key" "local" {
  #checkov:skip=CKV2_AWS_64:LocalStack-only key; default policy is fine for a disposable emulator
  description             = "${var.name}: LocalStack data key"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

module "messaging" {
  source = "../../modules/messaging"

  name        = var.name
  kms_key_arn = aws_kms_key.local.arn
  # CloudWatch alarms add nothing locally.
  create_dlq_alarm = false
}

module "storage" {
  source = "../../modules/storage"

  bucket_name          = "${var.name}-branding"
  kms_key_arn          = aws_kms_key.local.arn
  cors_allowed_origins = var.cors_origins
  force_destroy        = true
}

# Same secret shape as the cloud (JSON keys) so the secrets-loading code
# path can be integration-tested. Values are generated, never committed,
# and - as in the cloud - ephemeral + write-only, so they are not in the
# local state file either.
ephemeral "random_password" "local" {
  for_each = toset(["jwt_secret", "bvn_hmac_key"])

  length  = 64
  special = false
}

ephemeral "random_bytes" "data_encryption_key" {
  length = 32
}

resource "aws_secretsmanager_secret" "app" {
  #checkov:skip=CKV2_AWS_57:LocalStack-only secret; rotation irrelevant
  name                    = "${var.name}/app"
  kms_key_id              = aws_kms_key.local.arn
  recovery_window_in_days = 0 # allow instant re-create between runs
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string_wo = jsonencode({
    jwt_secret          = ephemeral.random_password.local["jwt_secret"].result
    bvn_hmac_key        = ephemeral.random_password.local["bvn_hmac_key"].result
    data_encryption_key = ephemeral.random_bytes.data_encryption_key.base64
  })
  # Constant: LocalStack state is throwaway (make clean recreates it).
  secret_string_wo_version = 1
}

# Tenant directory (global control plane). LocalStack gets a
# single-region table (no replicas): the same module, with cell_regions
# set to just the local region, so the app's directory code path (lookup,
# conditional register) is integration-testable.
module "directory" {
  source = "../../modules/directory"

  table_name                  = "${var.name}-tenant-directory"
  cell_regions                = [var.aws_region]
  kms_alias_prefix            = "alias/${var.name}-directory"
  kms_deletion_window_in_days = 7
  deletion_protection         = false
}
