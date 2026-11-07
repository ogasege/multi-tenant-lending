variable "name" {
  description = "Name prefix for all resources, e.g. \"lending-prod\"."
  type        = string
}

variable "vpc_id" {
  description = "VPC the database security group is created in."
  type        = string
}

variable "db_subnet_group_name" {
  description = "Existing DB subnet group (isolated database subnets)."
  type        = string
}

variable "allowed_security_group_ids" {
  description = "Security groups (e.g. ECS tasks) allowed to connect on 5432. Map key is a stable label."
  type        = map(string)
  default     = {}
}

variable "engine_version" {
  description = "PostgreSQL engine version. Major-only (\"16\") lets RDS apply minor upgrades in the maintenance window without plan drift."
  type        = string
  default     = "16"

  validation {
    condition     = can(regex("^16(\\.[0-9]+)?$", var.engine_version))
    error_message = "The platform is built and tested against PostgreSQL 16; engine_version must be 16 or 16.x."
  }
}

variable "instance_class" {
  description = "RDS instance class, e.g. db.t4g.micro (dev) or db.m7g.large (prod)."
  type        = string

  validation {
    condition     = startswith(var.instance_class, "db.")
    error_message = "instance_class must start with \"db.\"."
  }
}

variable "allocated_storage" {
  description = "Initial gp3 storage in GiB."
  type        = number
  default     = 20

  validation {
    condition     = var.allocated_storage >= 20
    error_message = "gp3 storage for PostgreSQL must be at least 20 GiB."
  }
}

variable "max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB (must exceed allocated_storage)."
  type        = number
  default     = 100
}

variable "multi_az" {
  description = "Synchronous standby in a second AZ with automatic failover (~2x instance cost)."
  type        = bool
  default     = true
}

variable "database_name" {
  description = "Initial database name (DATABASE_NAME)."
  type        = string
  default     = "lending"
}

variable "master_username" {
  description = "RDS master user. Used only by the one-off migrations task (schema owner)."
  type        = string
  default     = "lending_owner"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{1,62}$", var.master_username)) && !contains(["postgres", "rdsadmin", "admin"], var.master_username)
    error_message = "master_username must be a valid, non-reserved PostgreSQL identifier."
  }
}

variable "app_role_name" {
  description = "Login role used by the API (RLS enforced)."
  type        = string
  default     = "lending_app"
}

variable "worker_role_name" {
  description = "Login role used by the worker (NOBYPASSRLS; cross-tenant via the explicit worker_all RLS policy)."
  type        = string
  default     = "lending_worker"
}

variable "backup_retention_period" {
  description = "Days of automated backups / PITR window (1-35)."
  type        = number
  default     = 14

  validation {
    condition     = var.backup_retention_period >= 1 && var.backup_retention_period <= 35
    error_message = "backup_retention_period must be between 1 and 35 days."
  }
}

variable "deletion_protection" {
  description = "Block DeleteDBInstance until this is switched off."
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy. Only ever true for throwaway environments."
  type        = bool
  default     = false
}

variable "rds_kms_key_arn" {
  description = "CMK ARN for storage, snapshots and Performance Insights."
  type        = string
}

variable "secrets_kms_key_arn" {
  description = "CMK ARN for the RDS-managed master secret and role password secrets."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "CMK ARN for the exported PostgreSQL log groups."
  type        = string
}

variable "log_retention_in_days" {
  description = "Retention of exported PostgreSQL logs."
  type        = number
  default     = 30
}

variable "enable_cross_region_backup_replication" {
  description = "Replicate automated backups (snapshots + WAL for PITR) to dr_region."
  type        = bool
  default     = true
}

variable "dr_region" {
  description = "Region that receives replicated automated backups."
  type        = string
  default     = "eu-west-2"
}

variable "dr_backup_retention_period" {
  description = "Retention (days) of replicated backups in dr_region."
  type        = number
  default     = 7

  validation {
    condition     = var.dr_backup_retention_period >= 1 && var.dr_backup_retention_period <= 35
    error_message = "dr_backup_retention_period must be between 1 and 35 days."
  }
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window for the role password secrets."
  type        = number
  default     = 30
}

variable "permissions_boundary_arn" {
  description = "IAM permissions boundary attached to every role this module creates (required by the CI apply role; null only for admin-run applies)."
  type        = string
  default     = null
}

variable "role_password_version" {
  description = "Version of the lending_app / lending_worker passwords. Write-only secrets are only (re)written when this changes: bump it to rotate both passwords (migrations then apply them to Postgres)."
  type        = number
  default     = 1

  validation {
    condition     = var.role_password_version >= 1 && floor(var.role_password_version) == var.role_password_version
    error_message = "role_password_version must be a positive integer."
  }
}
