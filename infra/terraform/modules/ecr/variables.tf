variable "repository_name" {
  description = "ECR repository name, e.g. \"lending-prod/lending-core\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]+([._/-][a-z0-9]+)*$", var.repository_name))
    error_message = "repository_name must be a valid ECR repository name."
  }
}

variable "kms_key_arn" {
  description = "CMK ARN used to encrypt images."
  type        = string
}

variable "keep_tagged_images" {
  description = "Number of most recent tagged images retained (rollback depth)."
  type        = number
  default     = 30

  validation {
    condition     = var.keep_tagged_images >= 5
    error_message = "Keep at least 5 tagged images so rollbacks remain possible."
  }
}

variable "untagged_expiry_days" {
  description = "Days after which untagged images (failed/overwritten builds) are deleted."
  type        = number
  default     = 7
}

variable "force_delete" {
  description = "Allow deleting the repository while it still contains images."
  type        = bool
  default     = false
}
