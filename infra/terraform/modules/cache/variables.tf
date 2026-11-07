variable "name" {
  description = "Name prefix for all resources, e.g. \"lending-prod\"."
  type        = string
}

variable "vpc_id" {
  description = "VPC the cache security group is created in."
  type        = string
}

variable "subnet_ids" {
  description = "Isolated (database) subnet IDs for the cache subnet group."
  type        = list(string)
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to connect on 6379. Map key is a stable label."
  type        = map(string)
  default     = {}
}

variable "engine_version" {
  description = "Valkey engine version (major.minor)."
  type        = string
  default     = "8.0"

  validation {
    condition     = can(regex("^[78]\\.[0-9]+$", var.engine_version))
    error_message = "engine_version must be a Valkey 7.x or 8.x version, e.g. \"8.0\"."
  }
}

variable "node_type" {
  description = "Cache node type, e.g. cache.t4g.micro (dev) or cache.m7g.large (prod)."
  type        = string

  validation {
    condition     = startswith(var.node_type, "cache.")
    error_message = "node_type must start with \"cache.\"."
  }
}

variable "num_cache_clusters" {
  description = "Number of nodes (1 primary + N-1 replicas). Must be >= 2 when automatic_failover_enabled."
  type        = number
  default     = 2

  validation {
    condition     = var.num_cache_clusters >= 1 && var.num_cache_clusters <= 6
    error_message = "num_cache_clusters must be between 1 and 6."
  }
}

variable "automatic_failover_enabled" {
  description = "Promote a replica automatically if the primary fails (also enables Multi-AZ)."
  type        = bool
  default     = true

  validation {
    condition     = !var.automatic_failover_enabled || var.num_cache_clusters >= 2
    error_message = "automatic_failover_enabled requires num_cache_clusters >= 2."
  }
}

variable "snapshot_retention_limit" {
  description = "Days of daily snapshots to keep (0 disables). Cache data is rebuildable, so this is small."
  type        = number
  default     = 1
}

variable "kms_key_arn" {
  description = "CMK ARN for data at rest."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "CMK ARN for the AUTH token / REDIS_URL secret."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "CMK ARN for the slow-log log group."
  type        = string
}

variable "log_retention_in_days" {
  description = "Retention of the slow-log log group."
  type        = number
  default     = 30
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window for the AUTH secret."
  type        = number
  default     = 30
}

variable "auth_token_version" {
  description = "Version of the Valkey AUTH token. Write-only values are only (re)written when this changes: bump it to rotate (ROTATE strategy keeps the old token valid until a later SET)."
  type        = number
  default     = 1

  validation {
    condition     = var.auth_token_version >= 1 && floor(var.auth_token_version) == var.auth_token_version
    error_message = "auth_token_version must be a positive integer."
  }
}
