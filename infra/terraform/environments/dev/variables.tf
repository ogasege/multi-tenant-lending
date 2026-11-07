variable "environment" {
  description = "Environment name; fixed per directory."
  type        = string
  default     = "dev"

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
  description = "JWT_ISSUER value, e.g. https://api.dev.example.com."
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
  description = "KYC provider id (mock allowed outside prod)."
  type        = string
  default     = "mock"
}

variable "payment_provider" {
  description = "Disbursement payment provider id (PAYMENT_PROVIDER; mock allowed outside prod)."
  type        = string
  default     = "mock"
}

variable "credit_bureau_provider" {
  description = "Credit bureau id (CREDIT_BUREAU_PROVIDER; mock allowed outside prod)."
  type        = string
  default     = "mock"
}

variable "checkout_orders_provider" {
  description = "Checkout-order (procurement) provider id (CHECKOUT_ORDERS_PROVIDER; mock allowed outside prod)."
  type        = string
  default     = "mock"
}

variable "preserve_existing_app_secret" {
  description = "One-time migration to write-only secrets: re-write the existing application secret (JWT/BVN HMAC/DEK) instead of generating new keys. Set true for the first apply after upgrading an already-deployed environment, then false."
  type        = bool
  default     = false
}
