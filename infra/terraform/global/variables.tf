variable "environment" {
  description = "Environment tier this control plane serves (each tier has its own directory and routing)."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "aws_account_id" {
  description = "AWS account (provider allowed_account_ids guard)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "Region of the primary directory table (see ADR-001)."
  type        = string
  default     = "af-south-1"
}

variable "cell_regions" {
  description = "Regions that host (or will host) a cell; each gets a directory replica."
  type        = list(string)
  default     = ["af-south-1", "eu-west-3", "eu-west-2"]
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone for api_domain."
  type        = string
}

variable "api_domain" {
  description = "Global API hostname for this tier, e.g. api.example.com (prod) or api.dev.example.com."
  type        = string
}

variable "cells" {
  description = "Deployed cells: region => ALB dns name / zone id (from each cell's alb outputs). Empty on the very first apply."
  type = map(object({
    alb_dns_name = string
    alb_zone_id  = string
  }))
  default = {}
}

variable "owner" {
  description = "Owner tag."
  type        = string
  default     = "platform-team"
}

variable "cost_center" {
  description = "CostCenter tag."
  type        = string
  default     = "lending-core"
}
