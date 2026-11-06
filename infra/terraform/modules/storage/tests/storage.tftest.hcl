# Unit tests: `terraform test` (from modules/storage), no AWS access.

mock_provider "aws" {
  # The bucket ARN is computed; give it a realistic value so policy
  # resources built from it can be asserted.
  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::lending-test-branding"
      id  = "lending-test-branding"
    }
  }
  # Mocked data sources return random strings; resources that validate
  # their policy argument need syntactically valid JSON.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  bucket_name          = "lending-test-branding"
  kms_key_arn          = "arn:aws:kms:af-south-1:111111111111:key/00000000-0000-0000-0000-000000000000"
  cors_allowed_origins = ["https://app.example.com"]
}

run "block_public_access_all_four" {
  command = plan

  assert {
    condition = (
      aws_s3_bucket_public_access_block.this.block_public_acls &&
      aws_s3_bucket_public_access_block.this.block_public_policy &&
      aws_s3_bucket_public_access_block.this.ignore_public_acls &&
      aws_s3_bucket_public_access_block.this.restrict_public_buckets
    )
    error_message = "All four Block Public Access settings must be enabled."
  }
}

run "acls_disabled" {
  command = plan

  assert {
    condition     = aws_s3_bucket_ownership_controls.this.rule[0].object_ownership == "BucketOwnerEnforced"
    error_message = "Object ownership must be BucketOwnerEnforced (ACLs disabled)."
  }
}

run "sse_kms_with_bucket_key" {
  command = plan

  # rule is a set-typed block: iterate rather than index.
  assert {
    condition = alltrue([
      for r in aws_s3_bucket_server_side_encryption_configuration.this.rule :
      r.bucket_key_enabled && alltrue([
        for d in r.apply_server_side_encryption_by_default :
        d.sse_algorithm == "aws:kms" && d.kms_master_key_id == var.kms_key_arn
      ])
    ])
    error_message = "Default encryption must be SSE-KMS with the supplied CMK and bucket key enabled."
  }
}

run "versioning_and_noncurrent_lifecycle" {
  command = plan

  assert {
    condition     = aws_s3_bucket_versioning.this.versioning_configuration[0].status == "Enabled"
    error_message = "Versioning must be enabled."
  }

  assert {
    condition = anytrue([
      for r in aws_s3_bucket_lifecycle_configuration.this.rule : anytrue([
        for n in r.noncurrent_version_expiration : n.noncurrent_days == 30
      ])
    ])
    error_message = "Noncurrent versions must expire after 30 days by default."
  }
}

# apply against the MOCK provider (still no AWS calls, no cost): the
# bucket ARN is computed, and Terraform 1.10 only applies mock values
# for computed attributes during apply.
run "tls_only_and_tenant_prefix_policy" {
  command = apply

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.this.statement :
      s.sid == "DenyInsecureTransport" && s.effect == "Deny"
    ])
    error_message = "Bucket policy must deny non-TLS requests."
  }

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.this.statement :
      s.sid == "DenyWritesOutsideTenantPrefix" && try(contains(s.not_resources, "arn:aws:s3:::lending-test-branding/tenants/*"), false)
    ])
    error_message = "Bucket policy must deny PutObject outside tenants/*."
  }

  assert {
    condition     = output.tenant_objects_arn == "arn:aws:s3:::lending-test-branding/tenants/*"
    error_message = "tenant_objects_arn must scope IAM to the tenants/ prefix."
  }
}

run "cors_for_presigned_put" {
  command = plan

  assert {
    condition = alltrue([
      for r in aws_s3_bucket_cors_configuration.this.cors_rule :
      contains(r.allowed_methods, "PUT") && r.allowed_origins == toset(var.cors_allowed_origins)
    ])
    error_message = "CORS must allow PUT from exactly the configured origins."
  }
}

run "rejects_wildcard_cors_origin" {
  command = plan

  variables {
    cors_allowed_origins = ["*"]
  }

  expect_failures = [var.cors_allowed_origins]
}

run "rejects_invalid_bucket_name" {
  command = plan

  variables {
    bucket_name = "Invalid_Bucket"
  }

  expect_failures = [var.bucket_name]
}

run "rejects_prefix_without_trailing_slash" {
  command = plan

  variables {
    tenant_prefix = "tenants"
  }

  expect_failures = [var.tenant_prefix]
}
