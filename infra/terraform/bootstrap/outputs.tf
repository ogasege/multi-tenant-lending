output "state_bucket" {
  description = "State bucket name; pass as -backend-config=\"bucket=...\" to each environment."
  value       = aws_s3_bucket.state.id
}

output "state_kms_key_arn" {
  description = "CMK encrypting Terraform state."
  value       = aws_kms_key.state.arn
}

output "workload_boundary_arns" {
  description = "Map of environment to the permissions boundary every role created by that env's pipeline must carry."
  value       = { for k, p in aws_iam_policy.boundary : k => p.arn }
}

output "plan_role_arn" {
  description = "Role for reviewer-gated PR plans (read-only, non-prod state); set as AWS_PLAN_ROLE_ARN on the plan GitHub Environment."
  value       = aws_iam_role.plan.arn
}

output "apply_role_arns" {
  description = "Map of environment to apply role ARN; set as AWS_APPLY_ROLE_ARN on each GitHub Environment."
  value       = { for k, r in aws_iam_role.apply : k => r.arn }
}

output "github_oidc_subject_template" {
  description = "OIDC subject customisation the CI role trust policies expect; PUT it to repos/<repo>/actions/oidc/customization/sub (README)."
  value = {
    use_default        = false
    include_claim_keys = ["repo", "context", "ref", "job_workflow_ref"]
  }
}

output "github_oidc_subjects" {
  description = "Exact (apply) and pattern (plan) OIDC subjects each CI role trusts, for review against the GitHub settings."
  value = {
    plan  = local.plan_subject
    apply = local.apply_subjects
  }
}
