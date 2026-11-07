variable "name" {
  description = "Name prefix for all resources, e.g. \"lending-prod\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "name must be 3-31 chars of lowercase letters, digits and hyphens."
  }
}

variable "kms_deletion_window_in_days" {
  description = "Waiting period before a scheduled CMK deletion completes (7-30 days)."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "kms_deletion_window_in_days must be between 7 and 30."
  }
}

variable "waf_rate_limit_per_ip" {
  description = "Max requests per source IP per 5-minute window across the whole API before WAF blocks."
  type        = number
  default     = 2000

  validation {
    condition     = var.waf_rate_limit_per_ip >= 10
    error_message = "WAF rate-based rules require a limit of at least 10."
  }
}

variable "waf_auth_rate_limit_per_ip" {
  description = "Max requests per source IP per 5-minute window to /v1/auth/*, /v1/platform/auth/* and /v1/institutions/*/customers/register (credential stuffing / signup abuse guard)."
  type        = number
  default     = 100

  validation {
    condition     = var.waf_auth_rate_limit_per_ip >= 10
    error_message = "WAF rate-based rules require a limit of at least 10."
  }
}

variable "log_retention_in_days" {
  description = "Retention for the WAF log group."
  type        = number
  default     = 90

  validation {
    condition = contains(
      [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653],
      var.log_retention_in_days,
    )
    error_message = "log_retention_in_days must be a value CloudWatch Logs accepts."
  }
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window for the application secret (0 forces immediate deletion; use only in throwaway envs)."
  type        = number
  default     = 30

  validation {
    condition     = var.secret_recovery_window_in_days == 0 || (var.secret_recovery_window_in_days >= 7 && var.secret_recovery_window_in_days <= 30)
    error_message = "secret_recovery_window_in_days must be 0 or between 7 and 30."
  }
}

variable "platform_admin_cidrs" {
  description = "IPv4 CIDRs (admin network / VPN egress) allowed to reach /v1/platform/*. Empty = restriction disabled."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.platform_admin_cidrs : can(cidrhost(c, 0)) && !strcontains(c, ":")])
    error_message = "platform_admin_cidrs must be IPv4 CIDRs, e.g. 203.0.113.0/24."
  }
}

variable "app_secret_version" {
  description = "Version of the application secret (JWT_SECRET, BVN_HMAC_KEY, DATA_ENCRYPTION_KEY). Bumping it writes NEW keys: do so only once the app supports a dual-key window (old ciphertext and BVN hashes must stay readable)."
  type        = number
  default     = 1

  validation {
    condition     = var.app_secret_version >= 1 && floor(var.app_secret_version) == var.app_secret_version
    error_message = "app_secret_version must be a positive integer."
  }
}

variable "preserve_existing_app_secret" {
  description = "One-time migration switch: when the write-only secret version is first applied to an environment that already has an application secret, re-write the current value instead of generating new keys. Set true for that one apply, then back to false."
  type        = bool
  default     = false
}
