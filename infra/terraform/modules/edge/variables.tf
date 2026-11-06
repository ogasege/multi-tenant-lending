variable "name" {
  description = "Name prefix for health checks, e.g. \"lending-prod\"."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route 53 public hosted zone that contains api_domain."
  type        = string
}

variable "api_domain" {
  description = "Global API hostname, e.g. \"api.example.com\". Cells are served at <region>.<api_domain>."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.api_domain))
    error_message = "api_domain must be a lowercase DNS name."
  }
}

variable "cells" {
  description = "Map of cell region to its ALB (dns_name, zone_id), from each cell's outputs."
  type = map(object({
    alb_dns_name = string
    alb_zone_id  = string
  }))
}

variable "default_region" {
  description = "Cell that receives traffic matching no geolocation rule (and the fallback when a narrower cell is unhealthy)."
  type        = string
  default     = "af-south-1"
}

variable "geo_routing" {
  description = <<-EOT
    Geolocation rules for the global api_domain record: id => { continent or country, region }.
    Only discovery/unauthenticated traffic depends on this; tenant traffic is pinned by the directory
    (the app answers 307 to the tenant's home cell URL).
  EOT
  type = map(object({
    continent = optional(string)
    country   = optional(string)
    region    = string
  }))
  default = {
    africa  = { continent = "AF", region = "af-south-1" }
    europe  = { continent = "EU", region = "eu-west-2" }
    uk      = { country = "GB", region = "eu-west-2" }
    senegal = { country = "SN", region = "eu-west-3" }
    cote    = { country = "CI", region = "eu-west-3" }
    mali    = { country = "ML", region = "eu-west-3" }
    burkina = { country = "BF", region = "eu-west-3" }
    niger   = { country = "NE", region = "eu-west-3" }
    togo    = { country = "TG", region = "eu-west-3" }
    benin   = { country = "BJ", region = "eu-west-3" }
    guinbis = { country = "GW", region = "eu-west-3" }
  }

  validation {
    condition     = alltrue([for g in values(var.geo_routing) : (g.continent == null) != (g.country == null)])
    error_message = "Each geo_routing rule must set exactly one of continent or country."
  }
}

variable "health_check_path" {
  description = "Readiness path probed by Route 53 health checks."
  type        = string
  default     = "/health/ready"
}
