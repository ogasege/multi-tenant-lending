# Unit tests: `terraform test` (from modules/database), no AWS access.
# The real random provider runs (offline); only aws is mocked.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name                 = "lending-test"
  vpc_id               = "vpc-0123456789abcdef0"
  db_subnet_group_name = "lending-test-db"
  instance_class       = "db.t4g.micro"
  allocated_storage    = 20
  rds_kms_key_arn      = "arn:aws:kms:af-south-1:111111111111:key/rds"
  secrets_kms_key_arn  = "arn:aws:kms:af-south-1:111111111111:key/secrets"
  logs_kms_key_arn     = "arn:aws:kms:af-south-1:111111111111:key/logs"
}

run "master_password_managed_by_rds" {
  command = plan

  assert {
    condition     = aws_db_instance.this.manage_master_user_password == true
    error_message = "RDS must generate and own the master password (never in state)."
  }
}

run "role_passwords_are_write_only" {
  command = plan

  assert {
    condition     = alltrue([for v in aws_secretsmanager_secret_version.role : v.secret_string == null])
    error_message = "Role passwords must not be stored via secret_string (it lands in state)."
  }

  assert {
    condition     = alltrue([for v in aws_secretsmanager_secret_version.role : v.secret_string_wo == null])
    error_message = "Write-only values must never appear in the plan."
  }

  assert {
    condition     = alltrue([for v in aws_secretsmanager_secret_version.role : v.secret_string_wo_version == 1])
    error_message = "Role secrets must be versioned by role_password_version (default 1)."
  }

  assert {
    condition     = toset(keys(aws_secretsmanager_secret_version.role)) == toset(["app", "worker"])
    error_message = "One write-only secret per runtime role."
  }
}

run "rotation_bumps_version" {
  command = plan

  variables {
    role_password_version = 2
  }

  assert {
    condition     = alltrue([for v in aws_secretsmanager_secret_version.role : v.secret_string_wo_version == 2])
    error_message = "role_password_version must drive secret_string_wo_version."
  }
}

run "rejects_non_positive_version" {
  command = plan

  variables {
    role_password_version = 0
  }

  expect_failures = [var.role_password_version]
}
