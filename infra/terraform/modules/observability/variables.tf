variable "name" {
  description = "Name prefix for all resources, e.g. \"lending-prod\"."
  type        = string
}

variable "workloads" {
  description = "Workload keys that get an application log group (e.g. api, worker, migrate)."
  type        = set(string)

  validation {
    condition     = contains(var.workloads, "api")
    error_message = "workloads must include \"api\" (the per-tenant error metric filter reads its log group)."
  }
}

variable "log_retention_in_days" {
  description = "Retention of application log groups."
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

variable "logs_kms_key_arn" {
  description = "CMK ARN for the application log groups."
  type        = string
}

variable "sns_kms_key_arn" {
  description = "CMK ARN for the alarm SNS topic (key policy must allow cloudwatch.amazonaws.com)."
  type        = string
}

variable "alarm_email_endpoints" {
  description = "Email addresses subscribed to the alarm topic (each must confirm the subscription)."
  type        = list(string)
  default     = []
}

variable "ecs_cluster_name" {
  description = "ECS cluster name for service alarms."
  type        = string
}

variable "ecs_service_names" {
  description = "Map of workload key to ECS service name to alarm on."
  type        = map(string)
}

variable "enable_alb_alarms" {
  description = "Create ALB 5xx / latency alarms (static flag so count is known at plan)."
  type        = bool
  default     = true
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix (LoadBalancer dimension)."
  type        = string
  default     = null
}

variable "target_group_arn_suffix" {
  description = "Target group ARN suffix (TargetGroup dimension)."
  type        = string
  default     = null
}

variable "rds_instance_identifier" {
  description = "RDS instance identifier for database alarms."
  type        = string
}

variable "sqs_queue_name" {
  description = "Main queue name for the age-of-oldest-message alarm."
  type        = string
}

variable "thresholds" {
  description = "Alarm thresholds. Defaults are starting points to be tuned against real traffic."
  type = object({
    alb_5xx_count_5m            = optional(number, 10)
    target_p99_latency_seconds  = optional(number, 1.5)
    ecs_cpu_percent             = optional(number, 85)
    ecs_memory_percent          = optional(number, 85)
    rds_cpu_percent             = optional(number, 80)
    rds_free_storage_bytes      = optional(number, 5368709120) # 5 GiB
    rds_connections             = optional(number, 150)
    sqs_oldest_message_age_secs = optional(number, 300)
  })
  default = {}
}
