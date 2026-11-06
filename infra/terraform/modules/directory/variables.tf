variable "table_name" {
  description = "Name of the tenant directory table, e.g. \"lending-prod-tenant-directory\"."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{3,255}$", var.table_name))
    error_message = "table_name must be a valid DynamoDB table name."
  }
}

variable "cell_regions" {
  description = "Every region that hosts a cell. The current provider region holds the primary table; every other region gets a replica."
  type        = list(string)
  default     = ["af-south-1", "eu-west-3", "eu-west-2"]

  validation {
    condition     = length(var.cell_regions) == length(distinct(var.cell_regions)) && length(var.cell_regions) >= 1
    error_message = "cell_regions must be a non-empty list without duplicates."
  }
}

variable "kms_alias_prefix" {
  description = "Alias prefix for the per-region CMKs, e.g. \"alias/lending-prod-directory\" (region appended for replicas)."
  type        = string

  validation {
    condition     = startswith(var.kms_alias_prefix, "alias/")
    error_message = "kms_alias_prefix must start with \"alias/\"."
  }
}

variable "kms_deletion_window_in_days" {
  description = "Waiting period before a scheduled CMK deletion completes."
  type        = number
  default     = 30
}

variable "deletion_protection" {
  description = "Protect the table (and replicas) from deletion. false only for LocalStack."
  type        = bool
  default     = true
}
