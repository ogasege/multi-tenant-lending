data "aws_region" "current" {}

locals {
  primary_region  = data.aws_region.current.region
  replica_regions = toset([for r in var.cell_regions : r if r != local.primary_region])
}

# ---------------------------------------------------------------------
# One CMK per region: KMS keys are regional and each replica must be
# encrypted with a key in its own region (single-region keys keep the
# cell's key material in the cell's region).
# ---------------------------------------------------------------------

resource "aws_kms_key" "primary" {
  #checkov:skip=CKV2_AWS_64:Default key policy (root delegation) is intended; access is granted via IAM
  description             = "${var.table_name} (${local.primary_region})"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true
  rotation_period_in_days = 365
}

resource "aws_kms_alias" "primary" {
  name          = var.kms_alias_prefix
  target_key_id = aws_kms_key.primary.key_id
}

resource "aws_kms_key" "replica" {
  #checkov:skip=CKV2_AWS_64:Default key policy (root delegation) is intended; access is granted via IAM
  for_each = local.replica_regions

  region                  = each.key
  description             = "${var.table_name} replica (${each.key})"
  deletion_window_in_days = var.kms_deletion_window_in_days
  enable_key_rotation     = true
  rotation_period_in_days = 365
}

resource "aws_kms_alias" "replica" {
  for_each = local.replica_regions

  region        = each.key
  name          = var.kms_alias_prefix
  target_key_id = aws_kms_key.replica[each.key].key_id
}

# ---------------------------------------------------------------------
# Tenant directory: slug -> home cell. Routing metadata ONLY (slug,
# home region, status, cell base URL) - never PII or financial data, so
# replicating it across regions does not move regulated data.
# ---------------------------------------------------------------------

# DynamoDB global table (version 2019.11.21 via replica blocks):
# multi-active, every cell reads its LOCAL replica (single-digit ms, no
# cross-region call on the request path) and keeps working if another
# region is down.
resource "aws_dynamodb_table" "this" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST" # tiny, spiky traffic; no capacity planning
  hash_key     = "slug"

  attribute {
    name = "slug"
    type = "S"
  }

  # Streams are required for global-table replication.
  stream_enabled   = true
  stream_view_type = "NEW_AND_OLD_IMAGES"

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.primary.arn
  }

  # 35-day continuous backups: recover from a bad onboarding write.
  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = var.deletion_protection

  dynamic "replica" {
    for_each = local.replica_regions

    content {
      region_name                 = replica.key
      kms_key_arn                 = aws_kms_key.replica[replica.key].arn
      point_in_time_recovery      = true
      propagate_tags              = true
      deletion_protection_enabled = var.deletion_protection
    }
  }

  lifecycle {
    precondition {
      condition     = contains(var.cell_regions, local.primary_region)
      error_message = "The provider region (primary table) must be one of cell_regions."
    }
  }
}
