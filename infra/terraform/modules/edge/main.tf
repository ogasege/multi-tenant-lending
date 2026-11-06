locals {
  # Ignore rules that point at a region with no cell (yet).
  geo_rules = { for k, g in var.geo_routing : k => g if contains(keys(var.cells), g.region) }
}

# One HTTPS health check per cell against its readiness endpoint (DB +
# Redis reachable). A failing check removes that cell from geolocation
# answers so Route 53 falls back to the broader rule / default.
resource "aws_route53_health_check" "cell" {
  for_each = var.cells

  fqdn              = "${each.key}.${var.api_domain}"
  type              = "HTTPS"
  port              = 443
  resource_path     = var.health_check_path
  request_interval  = 30
  failure_threshold = 3
  enable_sni        = true
  measure_latency   = true

  tags = {
    Name = "${var.name}-${each.key}"
  }
}

# Stable per-cell hostname <region>.<api_domain>: what the app returns
# as CELL_API_BASE_URL and in 307 redirects. Tenant traffic never depends
# on geolocation.
resource "aws_route53_record" "cell" {
  # Alias targets are cell ALBs owned by other states (inputs); the
  # dangling-record risk is covered by health checks and
  # evaluate_target_health, and records are removed with the cell.
  #checkov:skip=CKV2_AWS_23:Alias target is a cell ALB from another state
  for_each = var.cells

  zone_id = var.hosted_zone_id
  name    = "${each.key}.${var.api_domain}"
  type    = "A"

  alias {
    name                   = each.value.alb_dns_name
    zone_id                = each.value.alb_zone_id
    evaluate_target_health = true
  }
}

# Global entry point for discovery / first contact.
resource "aws_route53_record" "geo" {
  # Alias targets are cell ALBs owned by other states (inputs); the
  # dangling-record risk is covered by health checks and
  # evaluate_target_health, and records are removed with the cell.
  #checkov:skip=CKV2_AWS_23:Alias target is a cell ALB from another state
  for_each = local.geo_rules

  zone_id         = var.hosted_zone_id
  name            = var.api_domain
  type            = "A"
  set_identifier  = each.key
  health_check_id = aws_route53_health_check.cell[each.value.region].id

  geolocation_routing_policy {
    continent = each.value.continent
    country   = each.value.country
  }

  alias {
    name                   = var.cells[each.value.region].alb_dns_name
    zone_id                = var.cells[each.value.region].alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "geo_default" {
  # Alias targets are cell ALBs owned by other states (inputs); the
  # dangling-record risk is covered by health checks and
  # evaluate_target_health, and records are removed with the cell.
  #checkov:skip=CKV2_AWS_23:Alias target is a cell ALB from another state
  zone_id         = var.hosted_zone_id
  name            = var.api_domain
  type            = "A"
  set_identifier  = "default"
  health_check_id = aws_route53_health_check.cell[var.default_region].id

  geolocation_routing_policy {
    country = "*"
  }

  alias {
    name                   = var.cells[var.default_region].alb_dns_name
    zone_id                = var.cells[var.default_region].alb_zone_id
    evaluate_target_health = true
  }

  lifecycle {
    precondition {
      condition     = contains(keys(var.cells), var.default_region)
      error_message = "default_region must be one of the cells."
    }
  }
}
