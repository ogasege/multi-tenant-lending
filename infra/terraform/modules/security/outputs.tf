output "kms_key_arns" {
  description = "Map of data domain (rds, elasticache, secrets, messaging, s3, logs, ecr) to CMK ARN."
  value       = { for k, v in aws_kms_key.this : k => v.arn }
}

output "web_acl_arn" {
  description = "ARN of the regional WAFv2 web ACL to associate with the ALB."
  value       = aws_wafv2_web_acl.this.arn
}

output "app_secret_arn" {
  description = "ARN of the Secrets Manager secret holding jwt_secret, bvn_hmac_key and data_encryption_key (JSON keys)."
  value       = aws_secretsmanager_secret.app.arn
}
