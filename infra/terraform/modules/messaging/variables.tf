variable "name" {
  description = "Name prefix for all resources, e.g. \"lending-prod\"."
  type        = string
}

variable "queue_name" {
  description = "Logical queue name; the full name is \"<name>-<queue_name>\"."
  type        = string
  default     = "domain-events"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,60}$", var.queue_name))
    error_message = "queue_name may contain only alphanumerics, hyphens and underscores (max 60)."
  }
}

variable "kms_key_arn" {
  description = "CMK ARN for SSE-KMS. Required: queue payloads contain tenant and loan identifiers."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN."
  }
}

variable "max_receive_count" {
  description = "Receives before a message is moved to the DLQ."
  type        = number
  default     = 5

  validation {
    condition     = var.max_receive_count >= 1 && var.max_receive_count <= 1000
    error_message = "max_receive_count must be between 1 and 1000."
  }
}

variable "visibility_timeout_seconds" {
  description = "How long a received message is hidden; must exceed the worst-case webhook delivery attempt (>= 60 s for the webhook worker)."
  type        = number
  default     = 60

  validation {
    condition     = var.visibility_timeout_seconds >= 60 && var.visibility_timeout_seconds <= 43200
    error_message = "visibility_timeout_seconds must be between 60 (worker delivery budget) and 43200."
  }
}

variable "message_retention_seconds" {
  description = "Retention on the main queue (default 4 days)."
  type        = number
  default     = 345600

  validation {
    condition     = var.message_retention_seconds >= 60 && var.message_retention_seconds <= 1209600
    error_message = "message_retention_seconds must be between 60 and 1209600."
  }
}

variable "create_dlq_alarm" {
  description = "Create a CloudWatch alarm when any message lands in the DLQ."
  type        = bool
  default     = true
}

variable "alarm_actions" {
  description = "SNS topic ARNs notified by the DLQ alarm."
  type        = list(string)
  default     = []
}
