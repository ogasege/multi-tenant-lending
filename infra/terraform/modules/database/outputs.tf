output "address" {
  description = "Hostname of the instance (DATABASE_HOST)."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Port of the instance (DATABASE_PORT)."
  value       = aws_db_instance.this.port
}

output "database_name" {
  description = "Database name (DATABASE_NAME)."
  value       = var.database_name
}

output "instance_identifier" {
  description = "RDS instance identifier (CloudWatch DBInstanceIdentifier dimension)."
  value       = aws_db_instance.this.identifier
}

output "instance_arn" {
  description = "ARN of the RDS instance."
  value       = aws_db_instance.this.arn
}

output "security_group_id" {
  description = "Security group attached to the instance."
  value       = aws_security_group.this.id
}

output "master_user_secret_arn" {
  description = "ARN of the RDS-managed master secret (JSON keys username/password). Grant ONLY to the migrations task."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "app_role_name" {
  description = "Name of the RLS-enforced runtime role (DATABASE_APP_USER)."
  value       = var.app_role_name
}

output "worker_role_name" {
  description = "Name of the worker role (DATABASE_WORKER_USER): NOBYPASSRLS, cross-tenant only via the worker_all RLS policy."
  value       = var.worker_role_name
}

output "app_role_secret_arn" {
  description = "ARN of the secret holding the lending_app password (JSON keys username, password)."
  value       = aws_secretsmanager_secret.role["app"].arn
}

output "worker_role_secret_arn" {
  description = "ARN of the secret holding the lending_worker password (JSON keys username, password)."
  value       = aws_secretsmanager_secret.role["worker"].arn
}
