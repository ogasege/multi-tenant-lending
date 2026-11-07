# Unit tests: `terraform test` (from modules/cache), no AWS access.
# The real random provider runs (offline); only aws is mocked.

mock_provider "aws" {}

variables {
  name                = "lending-test"
  vpc_id              = "vpc-0123456789abcdef0"
  subnet_ids          = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"]
  node_type           = "cache.t4g.micro"
  kms_key_arn         = "arn:aws:kms:af-south-1:111111111111:key/elasticache"
  secrets_kms_key_arn = "arn:aws:kms:af-south-1:111111111111:key/secrets"
  logs_kms_key_arn    = "arn:aws:kms:af-south-1:111111111111:key/logs"
}

run "auth_token_is_write_only_everywhere" {
  command = plan

  assert {
    condition     = aws_elasticache_replication_group.this.auth_token == null
    error_message = "The AUTH token must not be set via auth_token (it lands in state)."
  }

  assert {
    condition     = aws_elasticache_replication_group.this.auth_token_wo == null
    error_message = "Write-only values must never appear in the plan."
  }

  assert {
    condition     = aws_secretsmanager_secret_version.this.secret_string == null
    error_message = "REDIS_URL must not be stored via secret_string (it lands in state)."
  }

  assert {
    condition     = aws_secretsmanager_secret_version.this.secret_string_wo == null
    error_message = "Write-only values must never appear in the plan."
  }
}

run "token_and_secret_share_one_version" {
  command = plan

  variables {
    auth_token_version = 3
  }

  assert {
    condition = (
      aws_elasticache_replication_group.this.auth_token_wo_version == 3 &&
      aws_secretsmanager_secret_version.this.secret_string_wo_version == 3
    )
    error_message = "Cluster and secret must be rewritten together (same version) or REDIS_URL holds a dead token."
  }

  assert {
    condition     = aws_elasticache_replication_group.this.transit_encryption_mode == "required"
    error_message = "TLS must stay required."
  }
}

run "rejects_fractional_version" {
  command = plan

  variables {
    auth_token_version = 1.5
  }

  expect_failures = [var.auth_token_version]
}
