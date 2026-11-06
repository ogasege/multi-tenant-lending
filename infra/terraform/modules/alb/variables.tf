variable "name" {
  description = "Name prefix for all resources, e.g. \"lending-prod\" (ALB names are max 32 chars)."
  type        = string

  validation {
    condition     = length(var.name) <= 26
    error_message = "name must be <= 26 chars so derived ALB/target group names fit AWS's 32-char limit."
  }
}

variable "vpc_id" {
  description = "VPC for the ALB and target group."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets (one per AZ) for the internet-facing ALB."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "An ALB needs subnets in at least two AZs."
  }
}

variable "certificate_arn" {
  description = "ACM certificate ARN (same region as the ALB) for the HTTPS listener."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/.+$", var.certificate_arn))
    error_message = "certificate_arn must be an ACM certificate ARN."
  }
}

variable "ssl_policy" {
  description = "ELB TLS negotiation policy for the HTTPS listener."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"

  validation {
    condition     = startswith(var.ssl_policy, "ELBSecurityPolicy-TLS13-")
    error_message = "ssl_policy must be one of the TLS 1.3 ELBSecurityPolicy-TLS13-* policies."
  }
}

variable "target_port" {
  description = "Container port the API listens on (PORT)."
  type        = number
  default     = 3000
}

variable "health_check_path" {
  description = "Readiness path checked by the target group."
  type        = string
  default     = "/health/ready"
}

variable "deletion_protection" {
  description = "Protect the ALB from deletion."
  type        = bool
  default     = true
}

variable "associate_waf" {
  description = "Associate web_acl_arn with the ALB. A static bool (not a null check) so count is known at plan time."
  type        = bool
  default     = true
}

variable "web_acl_arn" {
  description = "WAFv2 regional web ACL ARN to associate (required when associate_waf = true)."
  type        = string
  default     = null
}

variable "access_log_retention_days" {
  description = "Days to keep ALB access logs."
  type        = number
  default     = 90
}

variable "force_destroy_log_bucket" {
  description = "Allow destroying the access-log bucket while it contains logs."
  type        = bool
  default     = false
}
