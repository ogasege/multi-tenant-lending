variable "bucket_name" {
  description = "Globally unique bucket name for tenant branding assets."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name)) && !strcontains(var.bucket_name, "..")
    error_message = "bucket_name must be a valid S3 bucket name (3-63 chars, lowercase, digits, dots, hyphens)."
  }
}

variable "kms_key_arn" {
  description = "CMK ARN for SSE-KMS default encryption."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN."
  }
}

variable "tenant_prefix" {
  description = "Key prefix under which every object must live; objects are written as <tenant_prefix><tenantId>/..."
  type        = string
  default     = "tenants/"

  validation {
    condition     = endswith(var.tenant_prefix, "/") && !startswith(var.tenant_prefix, "/")
    error_message = "tenant_prefix must end with \"/\" and must not start with \"/\"."
  }
}

variable "cors_allowed_origins" {
  description = "Front-end origins allowed to PUT presigned uploads directly from the browser."
  type        = list(string)

  validation {
    condition     = length(var.cors_allowed_origins) > 0 && alltrue([for o in var.cors_allowed_origins : can(regex("^https?://[^*]+$", o))])
    error_message = "cors_allowed_origins must be a non-empty list of explicit http(s) origins (no wildcards)."
  }
}

variable "noncurrent_version_expiration_days" {
  description = "Days to keep overwritten/deleted object versions (undo window for branding changes)."
  type        = number
  default     = 30

  validation {
    condition     = var.noncurrent_version_expiration_days >= 1
    error_message = "noncurrent_version_expiration_days must be at least 1."
  }
}

variable "force_destroy" {
  description = "Allow destroying a non-empty bucket. Only for throwaway environments (local)."
  type        = bool
  default     = false
}
