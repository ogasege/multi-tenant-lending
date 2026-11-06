output "dns_name" {
  description = "ALB DNS name (point the API hostname's alias record here)."
  value       = aws_lb.this.dns_name
}

output "zone_id" {
  description = "Hosted zone ID of the ALB, for Route 53 alias records."
  value       = aws_lb.this.zone_id
}

output "arn_suffix" {
  description = "ALB ARN suffix (CloudWatch LoadBalancer dimension, autoscaling resource label)."
  value       = aws_lb.this.arn_suffix
}

output "security_group_id" {
  description = "ALB security group ID."
  value       = aws_security_group.this.id
}

output "target_group_arn" {
  description = "ARN of the API target group."
  value       = aws_lb_target_group.api.arn
}

output "target_group_arn_suffix" {
  description = "Target group ARN suffix (CloudWatch TargetGroup dimension)."
  value       = aws_lb_target_group.api.arn_suffix
}

output "access_log_bucket" {
  description = "Bucket receiving ALB access logs."
  value       = aws_s3_bucket.logs.id
}
