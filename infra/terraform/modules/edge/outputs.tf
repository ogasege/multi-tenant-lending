output "cell_hostnames" {
  description = "Map of cell region to its stable hostname (<region>.<api_domain>)."
  value       = { for r, rec in aws_route53_record.cell : r => rec.fqdn }
}

output "health_check_ids" {
  description = "Map of cell region to its Route 53 health check ID (empty when enable_health_checks = false)."
  value       = { for r, hc in aws_route53_health_check.cell : r => hc.id }
}
