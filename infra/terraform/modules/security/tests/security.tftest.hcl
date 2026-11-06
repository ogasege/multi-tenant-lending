# Unit tests: `terraform test` (from modules/security), no AWS access.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
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
