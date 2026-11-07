# Unit tests: `terraform test` (from bootstrap), no AWS access.
#
# The REAL aws provider renders aws_iam_policy_document locally, so the
# assertions check the exact trust/permission JSON IAM would receive.
# Every call that would reach AWS is skipped or overridden; with
# create_github_oidc_provider = false the provider ARN is computed, so
# the trust documents are fully known at plan time.

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
  target = data.aws_partition.current
  values = {
    partition = "aws"
  }
}

variables {
  github_repository           = "acme/lending"
  dns_zone_name               = "example.com"
  create_github_oidc_provider = false
}

run "plan_role_requires_plan_environment" {
  command = plan

  assert {
    condition = (
      jsondecode(data.aws_iam_policy_document.plan_trust.json).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"]
      == "repo:acme/lending:environment:plan:ref:refs/pull/*/merge:job_workflow_ref:acme/lending/.github/workflows/infra.yml@refs/pull/*/merge"
    )
    error_message = "The plan role must trust only reviewer-gated `plan` Environment jobs of infra.yml."
  }

  assert {
    condition     = !strcontains(data.aws_iam_policy_document.plan_trust.json, ":pull_request\"")
    error_message = "A bare pull_request subject must never be trusted (unreviewed PR code)."
  }
}

run "apply_roles_bound_to_main_and_deploy_workflow" {
  command = plan

  assert {
    condition = alltrue([
      for e in ["dev", "staging", "prod"] :
      jsondecode(data.aws_iam_policy_document.apply_trust[e].json).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]
      == "repo:acme/lending:environment:${e}:ref:refs/heads/main:job_workflow_ref:acme/lending/.github/workflows/infra.yml@refs/heads/main"
    ])
    error_message = "Apply roles must require Environment + refs/heads/main + infra.yml@main (exact match)."
  }

  assert {
    condition     = alltrue([for e in ["dev", "staging", "prod"] : !strcontains(data.aws_iam_policy_document.apply_trust[e].json, "*")])
    error_message = "Apply trust policies must not contain wildcards."
  }

  assert {
    condition     = alltrue([for e in ["dev", "staging", "prod"] : jsondecode(data.aws_iam_policy_document.apply_trust[e].json).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"])
    error_message = "Audience must be pinned to STS."
  }
}

run "health_checks_only_from_prod_role" {
  command = plan

  # Non-prod: no Allow for any health-check action and an explicit Deny.
  assert {
    condition = alltrue([
      for e in ["dev", "staging"] : alltrue([
        for s in jsondecode(data.aws_iam_policy_document.apply_dns[e].json).Statement :
        !strcontains(jsonencode(s.Action), "HealthCheck") if s.Effect == "Allow"
      ])
    ])
    error_message = "Non-prod roles must not be allowed any health-check action."
  }

  assert {
    condition = alltrue([
      for e in ["dev", "staging"] : anytrue([
        for s in jsondecode(data.aws_iam_policy_document.apply_dns[e].json).Statement :
        s.Effect == "Deny" && contains(flatten([s.Action]), "route53:DeleteHealthCheck") && contains(flatten([s.Action]), "route53:UpdateHealthCheck")
      ])
    ])
    error_message = "Non-prod roles must explicitly deny health-check writes."
  }

  # Prod: only CreateHealthCheck on "*" (no resource-level support);
  # everything else on health-check ARNs.
  assert {
    condition = alltrue([
      for s in jsondecode(data.aws_iam_policy_document.apply_dns["prod"].json).Statement :
      s.Resource != "*" || s.Action == "route53:CreateHealthCheck"
    ])
    error_message = "Prod DNS policy: only CreateHealthCheck may use Resource \"*\"."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(data.aws_iam_policy_document.apply_dns["prod"].json).Statement :
      s.Sid == "ManageHealthChecks" && s.Resource == "arn:aws:route53:::healthcheck/*"
    ])
    error_message = "Prod role must manage health checks by health-check ARN."
  }
}

run "rejects_workflow_path" {
  command = plan

  variables {
    github_deploy_workflow = ".github/workflows/infra.yml"
  }

  expect_failures = [var.github_deploy_workflow]
}
