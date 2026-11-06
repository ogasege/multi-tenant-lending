data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  account_id   = data.aws_caller_identity.current.account_id
  partition    = data.aws_partition.current.partition
  state_bucket = "${var.project}-tfstate-${local.account_id}"
  github_host  = "token.actions.githubusercontent.com"

  oidc_provider_arn = (
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : "arn:${local.partition}:iam::${local.account_id}:oidc-provider/${local.github_host}"
  )

  # CI roles/policies are named "github-<project>-*", deliberately
  # OUTSIDE the "<project>-<env>-*" IAM namespace the apply roles may
  # manage, so an apply role can never edit its own trust or policies.
  ci_prefix = "github-${var.project}"

  # One permissions boundary per environment (see boundary.tf).
  boundary_arns = {
    for e in var.environments :
    e => "arn:${local.partition}:iam::${local.account_id}:policy/${var.project}-boundary-${e}"
  }

  # Non-prod state keys the PR plan role may read.
  nonprod_envs = [for e in var.environments : e if e != "prod"]
}

# ---------------------------------------------------------------------
# State encryption key
# ---------------------------------------------------------------------

resource "aws_kms_key" "state" {
  #checkov:skip=CKV2_AWS_64:Default key policy (root delegation) is intended; access is granted via IAM roles below
  description             = "${var.project}: Terraform state"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  rotation_period_in_days = 365
}

resource "aws_kms_alias" "state" {
  name          = "alias/${var.project}-tfstate"
  target_key_id = aws_kms_key.state.key_id
}

# ---------------------------------------------------------------------
# State bucket
# ---------------------------------------------------------------------

resource "aws_s3_bucket" "state" {
  #checkov:skip=CKV_AWS_144:State stays in-region; versioning + deletion guard cover recovery
  #checkov:skip=CKV_AWS_18:Access audited via CloudTrail S3 data events
  #checkov:skip=CKV2_AWS_62:No event consumers for state objects
  bucket = local.state_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versioning: every state write is a new version, so a corrupted or
# accidentally emptied state can be rolled back.
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# SSE-KMS with a CMK: state contains generated secrets (role passwords,
# Redis token), so reading state must require kms:Decrypt on this key -
# a second, auditable gate beyond s3:GetObject.
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = 90
      newer_noncurrent_versions = 20
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyBucketDeletion"
    effect    = "Deny"
    actions   = ["s3:DeleteBucket"]
    resources = [aws_s3_bucket.state.arn]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}
