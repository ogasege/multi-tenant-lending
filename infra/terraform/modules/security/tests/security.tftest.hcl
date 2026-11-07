# Unit tests: `terraform test` (from modules/security), no AWS access.
#
# REAL aws provider, offline: Terraform 1.11 mock providers cannot mock
# ephemeral resources (this module has one), and plan-only runs make no
# API calls once credentials checks are skipped and the identity data
# sources are overridden. Bonus: KMS key policies render for real.

provider "aws" {
  region                      = "af-south-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "111111111111"
  }
}

override_data {
  target = data.aws_region.current
  values = {
    region = "af-south-1"
  }
}

override_data {
  target = data.aws_partition.current
  values = {
    partition = "aws"
  }
}

variables {
  name = "lending-test"
}

run "strict_rate_rule_covers_auth_and_registration" {
  command = plan

  assert {
    condition = anytrue([
      for r in aws_wafv2_web_acl.this.rule : r.name == "RateLimitAuthPerIp" && anytrue([
        for s in r.statement : anytrue([
          for rb in s.rate_based_statement : anytrue([
            for sd in rb.scope_down_statement : anytrue([
              for rx in sd.regex_match_statement :
              regex(rx.regex_string, "/v1/auth/login") != "" &&
              regex(rx.regex_string, "/v1/platform/auth/login") != "" &&
              regex(rx.regex_string, "/v1/institutions/acme-bank/customers/register") != "" &&
              !can(regex(rx.regex_string, "/v1/loans"))
            ])
          ])
        ])
      ])
    ])
    error_message = "The strict rate rule must cover tenant/platform auth and customer registration only."
  }
}

run "admin_allow_list_disabled_by_default" {
  command = plan

  assert {
    condition     = length(aws_wafv2_ip_set.platform_admin) == 0
    error_message = "No IP set when platform_admin_cidrs is empty."
  }

  assert {
    condition     = !anytrue([for r in aws_wafv2_web_acl.this.rule : r.name == "PlatformAdminFromAllowListOnly"])
    error_message = "No allow-list rule when platform_admin_cidrs is empty."
  }
}

run "admin_allow_list_enabled" {
  command = plan

  variables {
    platform_admin_cidrs = ["203.0.113.0/24"]
  }

  assert {
    condition     = aws_wafv2_ip_set.platform_admin[0].addresses == toset(["203.0.113.0/24"])
    error_message = "IP set must contain the admin CIDRs."
  }

  assert {
    condition = anytrue([
      for r in aws_wafv2_web_acl.this.rule :
      r.name == "PlatformAdminFromAllowListOnly" && r.priority == 5 && anytrue([for a in r.action : length(a.block) == 1])
    ])
    error_message = "A blocking allow-list rule must run first when admin CIDRs are set."
  }
}

run "rejects_ipv6_admin_cidr" {
  command = plan

  variables {
    platform_admin_cidrs = ["2001:db8::/32"]
  }

  expect_failures = [var.platform_admin_cidrs]
}

run "kms_keys_rotate" {
  command = plan

  assert {
    condition     = alltrue([for k in values(aws_kms_key.this) : k.enable_key_rotation && !k.multi_region])
    error_message = "All CMKs must rotate and be single-region."
  }
}

run "app_secret_is_write_only" {
  command = plan

  assert {
    condition     = aws_secretsmanager_secret_version.app.secret_string == null
    error_message = "App keys must not be stored via secret_string (it lands in state)."
  }

  assert {
    condition     = aws_secretsmanager_secret_version.app.secret_string_wo == null
    error_message = "Write-only values must never appear in the plan."
  }

  assert {
    condition     = aws_secretsmanager_secret_version.app.secret_string_wo_version == 1
    error_message = "App secret must be versioned (default 1); bumping it rotates keys."
  }

}

# One-time migration: plans offline too, because the secret id is
# unknown until apply (the read is deferred, no API call at plan time).
run "preserve_mode_keeps_write_only" {
  command = plan

  variables {
    preserve_existing_app_secret = true
  }

  assert {
    condition = (
      aws_secretsmanager_secret_version.app.secret_string == null &&
      aws_secretsmanager_secret_version.app.secret_string_wo_version == 1
    )
    error_message = "Preserving the existing value must still go through the write-only argument."
  }
}

run "rejects_non_positive_app_secret_version" {
  command = plan

  variables {
    app_secret_version = 0
  }

  expect_failures = [var.app_secret_version]
}
