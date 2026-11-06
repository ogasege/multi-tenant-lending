resource "aws_s3_bucket" "this" {
  # Branding assets are re-uploadable by tenants and versioned here;
  # cross-region replication would also copy tenant data out of the
  # primary region, which the residency posture avoids.
  #checkov:skip=CKV_AWS_144:CRR deliberately off (data residency); versioning gives undo
  # Object-level audit is CloudTrail S3 data events (org trail), which
  # are queryable and tamper-evident; server access logs add little.
  #checkov:skip=CKV_AWS_18:Audit via CloudTrail data events instead of server access logs
  # No consumer needs object-created events today.
  #checkov:skip=CKV2_AWS_62:No event consumers; add when image processing lands
  bucket        = var.bucket_name
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  # All four on: no ACL or policy can ever make this bucket public.
  # Logos reach browsers via presigned GET (or CloudFront OAC later).
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ACLs disabled: the bucket owner owns every object and access is
# decided only by IAM + bucket policy (one place to audit).
resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }

    # Bucket key: S3 derives per-bucket data keys, cutting KMS request
    # cost by up to 99% for many small objects such as logos.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-noncurrent-and-abandoned-uploads"
    status = "Enabled"

    filter {}

    # Bound the cost of versioning while keeping an undo window.
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    # Presigned multipart uploads abandoned by browsers otherwise bill
    # forever and are invisible in the console.
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "remove-expired-delete-markers"
    status = "Enabled"

    filter {}

    expiration {
      expired_object_delete_marker = true
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

# Browsers PUT directly to S3 with a presigned URL (the API never
# proxies file bytes). CORS is limited to explicit origins and methods.
resource "aws_s3_bucket_cors_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  cors_rule {
    allowed_methods = ["PUT", "GET", "HEAD"]
    allowed_origins = var.cors_allowed_origins
    allowed_headers = ["content-type", "content-md5", "x-amz-*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "this" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
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

  # SaaS isolation guard-rail: writes are only possible under
  # tenants/<tenantId>/. A bug that builds a key without the tenant
  # prefix fails loudly instead of creating an un-attributable object.
  statement {
    sid           = "DenyWritesOutsideTenantPrefix"
    effect        = "Deny"
    actions       = ["s3:PutObject"]
    not_resources = ["${aws_s3_bucket.this.arn}/${var.tenant_prefix}*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.this.json

  # Public access block must exist first or a policy race can briefly
  # evaluate without it.
  depends_on = [aws_s3_bucket_public_access_block.this]
}
