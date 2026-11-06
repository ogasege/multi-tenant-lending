variable "name" {
  description = "Name prefix; also the ECS cluster name, e.g. \"lending-prod\"."
  type        = string
}

variable "vpc_id" {
  description = "VPC for the task security groups."
  type        = string
}

variable "vpc_cidr_block" {
  description = "VPC CIDR; tasks may reach PostgreSQL/Valkey only inside it."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets the tasks run in (no public IPs)."
  type        = list(string)
}

variable "container_image" {
  description = "Full image reference. Prefer a digest (repo@sha256:...) so every env runs identical bytes."
  type        = string

  validation {
    condition     = can(regex("^[^\\s]+(:[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$", var.container_image))
    error_message = "container_image must include a tag or an @sha256 digest."
  }
}

variable "ecr_repository_arn" {
  description = "ECR repository of the shared image; each execution role may pull only from its workload's repository."
  type        = string
}

variable "container_insights" {
  description = "Container Insights mode: enabled or enhanced (per-task metrics, higher cost). Disabling is not allowed."
  type        = string
  default     = "enabled"

  validation {
    condition     = contains(["enabled", "enhanced"], var.container_insights)
    error_message = "container_insights must be enabled or enhanced."
  }
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture. ARM64 (Graviton) is ~20% cheaper per vCPU-hour; the image must be built for it."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
}

variable "container_user" {
  description = "uid:gid the container runs as (distroless :nonroot user is 65532)."
  type        = string
  default     = "65532:65532"

  validation {
    condition     = can(regex("^[1-9][0-9]*:[1-9][0-9]*$", var.container_user))
    error_message = "container_user must be a non-root numeric uid:gid (not 0)."
  }
}

variable "common_environment" {
  description = "Plain (non-secret) environment variables shared by every workload."
  type        = map(string)
  default     = {}

  # Deployed tasks must talk to real AWS endpoints over TLS.
  validation {
    condition     = !contains(keys(var.common_environment), "AWS_ENDPOINT_URL")
    error_message = "AWS_ENDPOINT_URL is LocalStack-only and must not be set on deployed tasks."
  }

  validation {
    condition     = lookup(var.common_environment, "DATABASE_SSL", "true") == "true"
    error_message = "DATABASE_SSL must be \"true\" (RDS enforces rds.force_ssl)."
  }
}

variable "log_group_names" {
  description = "Map of workload key to pre-created CloudWatch log group name."
  type        = map(string)
}

variable "alb" {
  description = "ALB wiring for workloads with attach_to_alb = true. null when no ALB is used."
  type = object({
    security_group_id       = string
    target_group_arn        = string
    arn_suffix              = string
    target_group_arn_suffix = string
  })
  default = null
}

variable "workloads" {
  description = <<-EOT
    Map of workload key (api, worker, migrate) to its definition. All share one image.
    run_as_service = false creates only a task definition (one-off tasks such as migrations).
    secrets maps ENV_VAR => { secret_arn, json_key } and is the ONLY source of secret ARNs
    the workload's execution role may read.
  EOT
  type = map(object({
    command                = optional(list(string)) # null = image default CMD/ENTRYPOINT
    image                  = optional(string)       # per-workload override of container_image
    ecr_repository_arn     = optional(string)       # repo the override image is pulled from
    cpu                    = number
    memory                 = number
    run_as_service         = optional(bool, true)
    desired_count          = optional(number, 1)
    min_capacity           = optional(number, 1)
    max_capacity           = optional(number, 2)
    cpu_target_percent     = optional(number, 60)
    requests_per_target    = optional(number)
    attach_to_alb          = optional(bool, false)
    container_port         = optional(number)
    health_check_command   = optional(list(string))
    stop_timeout           = optional(number, 30)
    environment            = optional(map(string), {})
    secrets                = optional(map(object({ secret_arn = string, json_key = optional(string) })), {})
    secrets_kms_key_arns   = optional(list(string), [])
    sqs_send_queue_arns    = optional(list(string), [])
    sqs_consume_queue_arns = optional(list(string), [])
    s3_object_arns         = optional(list(string), [])
    kms_key_arns           = optional(list(string), [])
    # Tenant directory (global control plane): read-only vs read-write,
    # on THIS cell's regional replica ARN only.
    dynamodb_read_table_arns  = optional(list(string), [])
    dynamodb_write_table_arns = optional(list(string), [])
    # GetItem/PutItem/DeleteItem (slug reservation and its rollback).
    dynamodb_reserve_table_arns = optional(list(string), [])
  }))

  validation {
    condition = alltrue([for w in values(var.workloads) : contains(
      lookup({
        "256"  = [512, 1024, 2048]
        "512"  = range(1024, 4097, 1024)
        "1024" = range(2048, 8193, 1024)
        "2048" = range(4096, 16385, 1024)
        "4096" = range(8192, 30721, 1024)
      }, tostring(w.cpu), []),
      w.memory
    )])
    error_message = "Each workload's cpu:memory must be a valid Fargate cpu/memory combination (cpu 256-4096)."
  }

  validation {
    condition     = alltrue([for w in values(var.workloads) : (w.image == null) == (w.ecr_repository_arn == null)])
    error_message = "A workload image override must come with its ecr_repository_arn (and vice versa)."
  }

  validation {
    condition = alltrue([
      for w in values(var.workloads) :
      w.image == null || can(regex("^[^\\s]+(:[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$", w.image))
    ])
    error_message = "Workload image overrides must include a tag or an @sha256 digest."
  }

  validation {
    condition     = alltrue([for w in values(var.workloads) : w.stop_timeout >= 2 && w.stop_timeout <= 120])
    error_message = "stop_timeout must be between 2 and 120 seconds (Fargate maximum)."
  }

  validation {
    condition     = alltrue([for w in values(var.workloads) : w.min_capacity <= w.desired_count && w.desired_count <= w.max_capacity])
    error_message = "Each workload needs min_capacity <= desired_count <= max_capacity."
  }

  validation {
    condition     = alltrue([for w in values(var.workloads) : !w.attach_to_alb || (w.run_as_service && w.container_port != null)])
    error_message = "attach_to_alb requires run_as_service = true and a container_port."
  }

  validation {
    condition     = length([for w in values(var.workloads) : w if w.attach_to_alb]) <= 1
    error_message = "Only one workload can be attached to the single ALB target group."
  }
}

variable "permissions_boundary_arn" {
  description = "IAM permissions boundary attached to every role this module creates (required by the CI apply role; null only for admin-run applies)."
  type        = string
  default     = null
}
