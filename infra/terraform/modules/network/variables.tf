variable "name" {
  description = "Name prefix for all resources, e.g. \"lending-prod\"."
  type        = string
}

variable "vpc_cidr" {
  description = "IPv4 CIDR for the VPC. A /16 leaves room for 3 x /20 private subnets (4091 task IPs each)."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 16
    error_message = "vpc_cidr must be a valid IPv4 CIDR of /16 or larger."
  }
}

variable "az_count" {
  description = "Number of Availability Zones to span."
  type        = number
  default     = 3

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3 (RDS and ALB both need at least 2 AZs)."
  }
}

variable "single_nat_gateway" {
  description = "true = one shared NAT gateway (cheap, AZ-failure takes egress down); false = one NAT per AZ (HA)."
  type        = bool
  default     = false
}

variable "enable_interface_endpoints" {
  description = "Create interface VPC endpoints (ecr.api, ecr.dkr, logs, secretsmanager, sqs, kms, sts). Costs ~USD 7/endpoint/AZ/month."
  type        = bool
  default     = true
}

variable "flow_log_retention_in_days" {
  description = "Retention for the VPC flow log group."
  type        = number
  default     = 90
}

variable "logs_kms_key_arn" {
  description = "CMK ARN used to encrypt the VPC flow log group."
  type        = string
}

variable "enable_lagos_local_zone" {
  description = "Add an isolated private subnet in the Lagos Local Zone (af-south-1-los-1a). Requires the zone group to be opted in on the account. Off by default; see README (in-country data cell)."
  type        = bool
  default     = false
}

variable "lagos_local_zone_name" {
  description = "Name of the Lagos Local Zone used when enable_lagos_local_zone = true."
  type        = string
  default     = "af-south-1-los-1a"

  validation {
    condition     = startswith(var.lagos_local_zone_name, "af-south-1-los-")
    error_message = "lagos_local_zone_name must be a Lagos Local Zone of af-south-1 (af-south-1-los-*)."
  }
}

variable "permissions_boundary_arn" {
  description = "IAM permissions boundary attached to every role this module creates (required by the CI apply role; null only for admin-run applies)."
  type        = string
  default     = null
}
