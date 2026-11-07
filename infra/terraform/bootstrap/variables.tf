variable "aws_region" {
  description = "Region for the state bucket (same as the workloads' primary region, see ADR-001)."
  type        = string
  default     = "af-south-1"
}

variable "dr_region" {
  description = "DR region (RDS backup replication + its KMS key); the only other region CI may act in."
  type        = string
  default     = "eu-west-2"
}

variable "cell_regions" {
  description = "Extra regions hosting additional cells (see README \"Cells / multi-region\"); apply roles may act only in aws_region, dr_region and these."
  type        = list(string)
  default     = ["eu-west-3"]
}

variable "dns_zone_name" {
  description = "Public DNS zone the API names live in (e.g. example.com); apply roles may only change api records of their tier in it."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.dns_zone_name))
    error_message = "dns_zone_name must be a lowercase DNS name without a trailing dot."
  }
}

variable "project" {
  description = "Project slug. CI apply roles may only manage IAM roles/policies named \"<project>-*\"."
  type        = string
  default     = "lending"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,11}$", var.project))
    error_message = "project must be 3-12 lowercase alphanumerics starting with a letter."
  }
}

variable "github_repository" {
  description = "GitHub repository allowed to assume the CI roles, as \"owner/name\"."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must be in the form owner/name."
  }
}

variable "github_deploy_workflow" {
  description = "Workflow file (in .github/workflows/) that runs plans and applies; part of the OIDC subject the CI roles trust."
  type        = string
  default     = "infra.yml"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+\\.ya?ml$", var.github_deploy_workflow))
    error_message = "github_deploy_workflow must be a bare workflow file name such as infra.yml."
  }
}

variable "environments" {
  description = "Environments (GitHub Environments of the same name) that get an apply role in THIS account. With one account per env, pass just that env."
  type        = set(string)
  default     = ["dev", "staging", "prod"]

  validation {
    condition     = alltrue([for e in var.environments : contains(["dev", "staging", "prod"], e)])
    error_message = "environments may contain only dev, staging and prod."
  }
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider (only one may exist per account; set false if it already exists)."
  type        = bool
  default     = true
}

variable "owner" {
  description = "Owner tag value."
  type        = string
  default     = "platform-team"
}
