output "repository_url" {
  description = "Repository URL to push to and to reference (with @sha256 digest) in task definitions."
  value       = aws_ecr_repository.this.repository_url
}

output "repository_arn" {
  description = "Repository ARN (scopes the ECS execution role's pull permissions)."
  value       = aws_ecr_repository.this.arn
}
