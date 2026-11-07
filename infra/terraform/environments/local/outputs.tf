output "sqs_domain_events_queue_url" {
  description = "SQS_DOMAIN_EVENTS_QUEUE_URL for the local .env."
  value       = module.messaging.queue_url
}

output "sqs_dlq_url" {
  description = "Dead-letter queue URL (assert redrive in integration tests)."
  value       = module.messaging.dlq_url
}

output "eu_sqs_domain_events_queue_url" {
  description = "EU_SQS_DOMAIN_EVENTS_QUEUE_URL for the local .env (profile two-cells)."
  value       = module.messaging_eu.queue_url
}

output "eu_sqs_dlq_url" {
  description = "EU cell dead-letter queue URL."
  value       = module.messaging_eu.dlq_url
}

output "s3_branding_bucket" {
  description = "S3_BRANDING_BUCKET for the local .env."
  value       = module.storage.bucket_name
}

output "kms_key_arn" {
  description = "LocalStack CMK ARN."
  value       = aws_kms_key.local.arn
}

output "app_secret_arn" {
  description = "Secret with jwt_secret / bvn_hmac_key / data_encryption_key."
  value       = aws_secretsmanager_secret.app.arn
}

output "directory_table_name" {
  description = "DIRECTORY_TABLE_NAME for the local .env."
  value       = module.directory.table_name
}
