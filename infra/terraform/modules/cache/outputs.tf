output "primary_endpoint_address" {
  description = "Primary endpoint hostname."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "replication_group_id" {
  description = "Replication group ID (CloudWatch dimension)."
  value       = aws_elasticache_replication_group.this.id
}

output "security_group_id" {
  description = "Security group attached to the cache nodes."
  value       = aws_security_group.this.id
}

output "redis_secret_arn" {
  description = "ARN of the secret with JSON keys auth_token and url (inject key url as REDIS_URL)."
  value       = aws_secretsmanager_secret.this.arn
}
