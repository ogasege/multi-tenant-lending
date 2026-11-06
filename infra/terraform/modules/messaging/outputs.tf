output "queue_url" {
  description = "URL of the domain-events queue (SQS_DOMAIN_EVENTS_QUEUE_URL)."
  value       = aws_sqs_queue.this.id
}

output "queue_arn" {
  description = "ARN of the domain-events queue (for IAM policies)."
  value       = aws_sqs_queue.this.arn
}

output "queue_name" {
  description = "Name of the domain-events queue (CloudWatch QueueName dimension)."
  value       = aws_sqs_queue.this.name
}

output "dlq_url" {
  description = "URL of the dead-letter queue."
  value       = aws_sqs_queue.dlq.id
}

output "dlq_arn" {
  description = "ARN of the dead-letter queue."
  value       = aws_sqs_queue.dlq.arn
}

output "dlq_name" {
  description = "Name of the dead-letter queue."
  value       = aws_sqs_queue.dlq.name
}
