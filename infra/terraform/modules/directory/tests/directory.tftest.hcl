# Unit tests: `terraform test` (from modules/directory), no AWS access.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      region = "af-south-1"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:af-south-1:111111111111:key/00000000-0000-0000-0000-000000000000"
    }
  }
}

variables {
  table_name       = "lending-test-tenant-directory"
  kms_alias_prefix = "alias/lending-test-directory"
}

run "encrypted_with_cmk_and_pitr" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.this.server_side_encryption[0].enabled
    error_message = "Table must use server-side encryption."
  }

  assert {
    condition     = aws_dynamodb_table.this.point_in_time_recovery[0].enabled
    error_message = "Point-in-time recovery must be enabled."
  }

  assert {
    condition     = aws_dynamodb_table.this.deletion_protection_enabled
    error_message = "Deletion protection must be on by default."
  }

  assert {
    condition     = aws_dynamodb_table.this.billing_mode == "PAY_PER_REQUEST" && aws_dynamodb_table.this.hash_key == "slug"
    error_message = "Table must be on-demand and keyed by slug."
  }

  assert {
    condition     = aws_dynamodb_table.this.stream_enabled
    error_message = "Streams are required for global table replication."
  }
}

run "replicas_in_every_other_cell_region" {
  command = plan

  assert {
    condition     = toset([for r in aws_dynamodb_table.this.replica : r.region_name]) == toset(["eu-west-3", "eu-west-2"])
    error_message = "Every cell region except the primary must get a replica."
  }

  assert {
    condition     = alltrue([for r in aws_dynamodb_table.this.replica : r.point_in_time_recovery && r.deletion_protection_enabled])
    error_message = "Replicas must have PITR and deletion protection."
  }

  assert {
    condition     = toset(keys(aws_kms_key.replica)) == toset(["eu-west-3", "eu-west-2"])
    error_message = "Each replica region must get its own CMK."
  }

  assert {
    condition     = alltrue([for k in values(aws_kms_key.replica) : k.enable_key_rotation])
    error_message = "Replica CMKs must rotate."
  }
}

# Replica key ARNs are computed; apply against the mock to check that each
# replica is wired to a CMK.
run "replicas_use_cmks" {
  command = apply

  assert {
    condition     = alltrue([for r in aws_dynamodb_table.this.replica : startswith(r.kms_key_arn, "arn:aws:kms:")])
    error_message = "Every replica must be encrypted with a CMK."
  }
}

run "single_region_for_localstack" {
  command = plan

  variables {
    cell_regions        = ["af-south-1"]
    deletion_protection = false
  }

  assert {
    condition     = length(aws_dynamodb_table.this.replica) == 0
    error_message = "A single cell region must produce no replicas."
  }
}

run "rejects_primary_outside_cell_regions" {
  command = plan

  variables {
    cell_regions = ["eu-west-2"]
  }

  expect_failures = [aws_dynamodb_table.this]
}

run "rejects_duplicate_regions" {
  command = plan

  variables {
    cell_regions = ["af-south-1", "af-south-1"]
  }

  expect_failures = [var.cell_regions]
}
