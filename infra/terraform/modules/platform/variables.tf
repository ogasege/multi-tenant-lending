variable "project" {
  description = "Short project slug used in every resource name."
  type        = string
  default     = "lending"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,11}$", var.project))
    error_message = "project must be 3-12 lowercase alphanumerics starting with a letter."
  }
}

variable "environment" {
  description = "Deployment environment. local (LocalStack) is a separate composition, not a value here."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "cell_id" {
  description = "Optional short cell suffix for additional regional cells (e.g. \"euw3\"). Empty for the primary cell. Keeps global names (IAM roles, buckets) unique per cell."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^([a-z0-9]{2,6})?$", var.cell_id))
    error_message = "cell_id must be empty or 2-6 lowercase alphanumerics."
  }
}

variable "dr_region" {
  description = "Region receiving replicated RDS automated backups."
  type        = string
}

# --- network ---------------------------------------------------------

variable "vpc_cidr" {
  description = "VPC CIDR (/16). Use distinct ranges per env so they can be peered later."
  type        = string
}

variable "single_nat_gateway" {
  description = "One shared NAT gateway (dev) vs one per AZ (staging/prod)."
  type        = bool
}

variable "enable_interface_endpoints" {
  description = "Create interface VPC endpoints for AWS APIs."
  type        = bool
}

variable "enable_lagos_local_zone" {
  description = "Add the optional Lagos Local Zone subnet (residency path, see README)."
  type        = bool
  default     = false
}

# --- database --------------------------------------------------------

variable "db_instance_class" {
  description = "RDS instance class. db.m7g is not offered in af-south-1; use db.t4g / db.m6g there."
  type        = string
}

variable "db_multi_az" {
  description = "Multi-AZ standby for RDS."
  type        = bool
}

variable "db_allocated_storage" {
  description = "Initial RDS storage (GiB)."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "RDS storage autoscaling ceiling (GiB)."
  type        = number
  default     = 100
}

variable "db_backup_retention_period" {
  description = "RDS automated backup retention (days)."
  type        = number
}

variable "enable_dr_backup_replication" {
  description = "Replicate RDS automated backups to dr_region (legal sign-off needed for Nigerian payment data, see README)."
  type        = bool
}

# --- cache -----------------------------------------------------------

variable "cache_node_type" {
  description = "ElastiCache node type."
  type        = string
}

variable "cache_num_nodes" {
  description = "Valkey nodes (primary + replicas)."
  type        = number
}

variable "cache_automatic_failover" {
  description = "Automatic failover / Multi-AZ for Valkey."
  type        = bool
}

# --- compute ---------------------------------------------------------

variable "image_reference" {
  description = "Image digest (\"sha256:...\", preferred - promoted unchanged dev -> staging -> prod) or an immutable tag."
  type        = string

  validation {
    condition     = can(regex("^(sha256:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$", var.image_reference))
    error_message = "image_reference must be sha256:<64 hex> or a valid image tag."
  }
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture (ARM64 = Graviton)."
  type        = string
  default     = "ARM64"
}

variable "container_insights" {
  description = "Container Insights mode for the cluster."
  type        = string
  default     = "enabled"
}

variable "api" {
  description = "API service sizing and scaling."
  type = object({
    cpu                 = number
    memory              = number
    desired_count       = number
    min_capacity        = number
    max_capacity        = number
    requests_per_target = optional(number, 500)
  })
}

variable "worker" {
  description = "Worker service sizing and scaling."
  type = object({
    cpu           = number
    memory        = number
    desired_count = number
    min_capacity  = number
    max_capacity  = number
  })
}

variable "migrations_image_reference" {
  description = "Digest (\"sha256:...\") of the Flyway migrations image (db/Dockerfile) in the migrations ECR repo; tags allowed but digests preferred."
  type        = string

  validation {
    condition     = can(regex("^(sha256:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$", var.migrations_image_reference))
    error_message = "migrations_image_reference must be sha256:<64 hex> or a valid image tag."
  }
}

variable "migrate" {
  description = "Migrations one-off task sizing (Flyway runs on the JVM: >= 512 MiB)."
  type = object({
    cpu    = number
    memory = number
  })
  default = { cpu = 512, memory = 1024 }

  validation {
    condition     = var.migrate.memory >= 512
    error_message = "The Flyway (JVM) migrations task needs at least 512 MiB."
  }
}

# --- edge ------------------------------------------------------------

variable "certificate_arn" {
  description = "ACM certificate ARN (in the primary region) for the API hostname."
  type        = string
}

variable "alb_deletion_protection" {
  description = "Deletion protection on the ALB."
  type        = bool
}

variable "waf_rate_limit_per_ip" {
  description = "Global WAF per-IP limit per 5 minutes."
  type        = number
  default     = 2000
}

variable "platform_admin_cidrs" {
  description = "IPv4 CIDRs allowed to reach /v1/platform/* (empty = no restriction)."
  type        = list(string)
  default     = []
}

variable "waf_auth_rate_limit_per_ip" {
  description = "WAF per-IP limit per 5 minutes on auth endpoints."
  type        = number
  default     = 100
}

# --- app config ------------------------------------------------------

variable "cors_origins" {
  description = "Front-end origins (CORS_ORIGINS and S3 presigned-upload CORS)."
  type        = list(string)
}

variable "api_domain" {
  description = "Global API hostname for this tier (e.g. api.example.com); the cell is served at <region>.<api_domain>."
  type        = string
}

variable "directory" {
  description = "Tenant directory from the global stack: table name and the CMK of THIS region's replica."
  type = object({
    table_name  = string
    kms_key_arn = string
  })
}

variable "jwt_issuer" {
  description = "JWT_ISSUER claim value, e.g. https://api.example.com."
  type        = string
}

variable "log_level" {
  description = "LOG_LEVEL for the app."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["fatal", "error", "warn", "info", "debug", "trace"], var.log_level)
    error_message = "log_level must be a pino level."
  }
}

# --- operations ------------------------------------------------------

variable "log_retention_in_days" {
  description = "Retention for application, WAF, flow and database logs."
  type        = number
  default     = 90
}

variable "alarm_email_endpoints" {
  description = "Email addresses subscribed to alarms."
  type        = list(string)
  default     = []
}

variable "kms_deletion_window_in_days" {
  description = "CMK deletion waiting period."
  type        = number
  default     = 30
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window."
  type        = number
  default     = 30
}

variable "alarm_thresholds" {
  description = "Overrides for observability alarm thresholds (see observability module)."
  type        = map(number)
  default     = {}
}

variable "permissions_boundary_arn" {
  description = "IAM permissions boundary attached to every role this module creates (required by the CI apply role; null only for admin-run applies)."
  type        = string
  default     = null
}

variable "rate_limits" {
  description = "App rate limits (per tenant per minute by principal kind, and customer self-signups per IP per hour)."
  type = object({
    tenant_staff_per_minute    = optional(number, 3000)
    tenant_customer_per_minute = optional(number, 1500)
    signup_per_hour            = optional(number, 30)
  })
  default = {}

  validation {
    condition     = var.rate_limits.tenant_staff_per_minute > 0 && var.rate_limits.tenant_customer_per_minute > 0 && var.rate_limits.signup_per_hour > 0
    error_message = "Rate limits must be positive."
  }
}

variable "cell_origins" {
  description = "Optional explicit map of cell region to https origin (CELL_ORIGINS). Empty = the app derives origins from CELL_ORIGIN_SUFFIX."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for o in values(var.cell_origins) : can(regex("^https://[a-z0-9.-]+$", o))])
    error_message = "cell_origins values must be https origins without a path, e.g. https://af-south-1.api.example.com."
  }
}

variable "kyc_provider" {
  description = "KYC_PROVIDER for the API. The app refuses \"mock\" in production, so prod must name a real provider before go-live."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9_-]+$", var.kyc_provider)) && !(var.environment == "prod" && var.kyc_provider == "mock")
    error_message = "kyc_provider must be a provider id, and \"mock\" is not allowed in prod."
  }
}

variable "payment_provider" {
  description = "PAYMENT_PROVIDER (disbursement payment provider) for the API. The app refuses \"mock\" in production, so prod must name a real provider before go-live."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9_-]+$", var.payment_provider)) && !(var.environment == "prod" && var.payment_provider == "mock")
    error_message = "payment_provider must be a provider id, and \"mock\" is not allowed in prod."
  }
}

variable "credit_bureau_provider" {
  description = "CREDIT_BUREAU_PROVIDER (credit bureau) for the API. The app refuses \"mock\" in production, so prod must name a real provider before go-live."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9_-]+$", var.credit_bureau_provider)) && !(var.environment == "prod" && var.credit_bureau_provider == "mock")
    error_message = "credit_bureau_provider must be a provider id, and \"mock\" is not allowed in prod."
  }
}

variable "checkout_orders_provider" {
  description = "CHECKOUT_ORDERS_PROVIDER (checkout-order (procurement) provider) for the API. The app refuses \"mock\" in production, so prod must name a real provider before go-live."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9_-]+$", var.checkout_orders_provider)) && !(var.environment == "prod" && var.checkout_orders_provider == "mock")
    error_message = "checkout_orders_provider must be a provider id, and \"mock\" is not allowed in prod."
  }
}

variable "repayment_max_backdate_days" {
  description = "REPAYMENT_MAX_BACKDATE_DAYS for the API: how many days before business today a repayment's value date may be (0 = today only)."
  type        = number
  default     = 3

  # Mirrors the app's zod schema (int 0-31) so a bad value fails at plan
  # time instead of crash-looping the API at boot.
  validation {
    condition     = var.repayment_max_backdate_days >= 0 && var.repayment_max_backdate_days <= 31 && floor(var.repayment_max_backdate_days) == var.repayment_max_backdate_days
    error_message = "repayment_max_backdate_days must be an integer between 0 and 31."
  }
}
