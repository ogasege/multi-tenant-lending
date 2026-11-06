output "log_group_names" {
  description = "Map of workload key to application log group name."
  value       = { for k, g in aws_cloudwatch_log_group.app : k => g.name }
}

output "alarm_topic_arn" {
  description = "SNS topic ARN that receives every alarm (wire to PagerDuty/Opsgenie/Slack)."
  value       = aws_sns_topic.alarms.arn
}
