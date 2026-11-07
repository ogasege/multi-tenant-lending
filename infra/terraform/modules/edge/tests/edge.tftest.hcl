# Unit tests: `terraform test` (from modules/edge), no AWS access.

mock_provider "aws" {
  mock_resource "aws_route53_health_check" {
    defaults = {
      id = "11111111-2222-3333-4444-555555555555"
    }
  }
}

variables {
  name           = "lending-test"
  hosted_zone_id = "Z0123456789ABCDEFGHIJ"
  api_domain     = "api.example.com"
  cells = {
    "af-south-1" = { alb_dns_name = "afs1.elb.amazonaws.com", alb_zone_id = "Z1" }
    "eu-west-3"  = { alb_dns_name = "euw3.elb.amazonaws.com", alb_zone_id = "Z2" }
  }
}

run "health_checks_by_default" {
  command = apply

  assert {
    condition     = length(aws_route53_health_check.cell) == 2
    error_message = "One health check per cell when enabled."
  }

  assert {
    condition     = aws_route53_record.geo_default.health_check_id == "11111111-2222-3333-4444-555555555555"
    error_message = "The default geo record must be health-checked when enabled."
  }
}

# Non-prod tiers: their CI roles hold no health-check permissions.
run "no_health_checks_when_disabled" {
  command = plan

  variables {
    enable_health_checks = false
  }

  assert {
    condition     = length(aws_route53_health_check.cell) == 0
    error_message = "No health checks may be created when disabled."
  }

  assert {
    condition = (
      aws_route53_record.geo_default.health_check_id == null &&
      alltrue([for r in aws_route53_record.geo : r.health_check_id == null])
    )
    error_message = "Records must not reference health checks when disabled."
  }

  assert {
    condition     = aws_route53_record.geo_default.alias[0].evaluate_target_health
    error_message = "Without health checks, ALB target health must still gate answers."
  }
}
