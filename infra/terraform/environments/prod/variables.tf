variable "environment" {
  description = "Environment name; fixed per directory."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "aws_account_id" {
  description = "AWS account this environment lives in (provider allowed_account_ids guard)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "Primary region (see ADR-001). af-south-1 is an opt-in region: enable it on the account first (bootstrap does this)."
  type        = string
  default     = "af-south-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must look like an AWS region code, e.g. af-south-1."
  }
}

variable "dr_region" {
  description = "Disaster-recovery region for replicated RDS backups (see ADR-001)."
  type        = string
  default     = "eu-west-2"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.dr_region)) && var.dr_region != var.aws_region
    error_message = "dr_region must be a valid region code different from aws_region."
  }
}

variable "owner" {
  description = "Owning team (Owner tag)."
  type        = string
  default     = "platform-team"
}

variable "cost_center" {
  description = "Cost center (CostCenter tag)."
  type        = string
  default     = "lending-core"
}

variable "image_reference" {
  description = "Image digest (sha256:...) promoted from the previous environment, or an immutable tag."
  type        = string
}

variable "migrations_image_reference" {
  description = "Digest (sha256:...) of the Flyway migrations image, promoted like the app image."
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate ARN for the API hostname, in aws_region."
  type        = string
}

variable "cors_origins" {
  description = "Front-end origins allowed by CORS and S3 presigned uploads."
  type        = list(string)
}

variable "jwt_issuer" {
  description = "JWT_ISSUER value, e.g. https://api.example.com."
  type        = string
}

variable "alarm_email_endpoints" {
  description = "Emails subscribed to the alarm topic."
  type        = list(string)
  default     = []
}

variable "api_domain" {
  description = "Global API hostname for this tier (CELL_API_BASE_URL = https://<region>.<api_domain>)."
  type        = string
}

variable "directory_table_name" {
  description = "Tenant directory table (global stack output directory_table_name)."
  type        = string
}

variable "directory_kms_key_arn" {
  description = "CMK of this region's directory replica (global stack output directory_regional_kms_key_arns[aws_region])."
  type        = string
}

variable "platform_admin_cidrs" {
  description = "Admin network IPv4 CIDRs allowed to call /v1/platform/* (empty = disabled)."
  type        = list(string)
  default     = []
}

variable "kyc_provider" {
  description = "Real KYC provider id for production. No default on purpose: the app refuses \"mock\" in production, so this must be decided before go-live."
  type        = string
}

variable "payment_provider" {
  description = "Real disbursement payment provider id for production (PAYMENT_PROVIDER). No default on purpose: the app refuses \"mock\" in production, so this must be decided before go-live."
  type        = string

  # Fail at the root, before the module call, with a prod-specific message.
  validation {
    condition     = var.payment_provider != "mock"
    error_message = "payment_provider must name a real provider in prod; \"mock\" is refused by the app."
  }
}

variable "credit_bureau_provider" {
  description = "Real credit bureau id for production (CREDIT_BUREAU_PROVIDER). No default on purpose: the app refuses \"mock\" in production, so this must be decided before go-live."
  type        = string

  # Fail at the root, before the module call, with a prod-specific message.
  validation {
    condition     = var.credit_bureau_provider != "mock"
    error_message = "credit_bureau_provider must name a real provider in prod; \"mock\" is refused by the app."
  }
}

variable "checkout_orders_provider" {
  description = "Real checkout-order (procurement) provider id for production (CHECKOUT_ORDERS_PROVIDER). No default on purpose: the app refuses \"mock\" in production, so this must be decided before go-live."
  type        = string

  # Fail at the root, before the module call, with a prod-specific message.
  validation {
    condition     = var.checkout_orders_provider != "mock"
    error_message = "checkout_orders_provider must name a real provider in prod; \"mock\" is refused by the app."
  }
}
