locals {
  t       = var.thresholds
  actions = [aws_sns_topic.alarms.arn]
}

# ---------------------------------------------------------------------
# Application log groups
# ---------------------------------------------------------------------

# Created here (not by the awslogs driver) so retention and the CMK are
# enforced from the first log line; auto-created groups never expire.
resource "aws_cloudwatch_log_group" "app" {
  for_each = var.workloads

  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = var.log_retention_in_days
  kms_key_id        = var.logs_kms_key_arn
}

# SaaS lens: pino emits tenantId on every line, so per-tenant error
# counts come from logs without app changes. Dimension cardinality =
# number of tenants; CloudWatch bills per metric and may disable a
# filter above ~1000 distinct values/hour - revisit beyond that scale.
resource "aws_cloudwatch_log_metric_filter" "errors_by_tenant" {
  name           = "${var.name}-errors-by-tenant"
  log_group_name = aws_cloudwatch_log_group.app["api"].name
  pattern        = "{ $.level >= 50 && $.tenantId = \"*\" }"

  metric_transformation {
    name       = "ErrorsByTenant"
    namespace  = "Lending/${var.name}"
    value      = "1"
    unit       = "Count"
    dimensions = { TenantId = "$.tenantId" }
  }
}

# Saved Logs Insights query: "which tenants are erroring, and on what".
resource "aws_cloudwatch_query_definition" "tenant_errors" {
  name            = "${var.name}/errors-by-tenant"
  log_group_names = [for g in aws_cloudwatch_log_group.app : g.name]

  query_string = <<-EOT
    fields @timestamp, tenantId, requestId, msg, err.code
    | filter level >= 50
    | stats count(*) as errors by tenantId, err.code
    | sort errors desc
  EOT
}

# ---------------------------------------------------------------------
# Alarm topic
# ---------------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = var.sns_kms_key_arn
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alarm_email_endpoints)

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# ---------------------------------------------------------------------
# ALB
# ---------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  for_each = var.enable_alb_alarms ? {
    elb    = "HTTPCode_ELB_5XX_Count"    # ALB itself (no healthy targets, 502/503/504)
    target = "HTTPCode_Target_5XX_Count" # application errors
  } : {}

  alarm_name          = "${var.name}-alb-${each.key}-5xx"
  alarm_description   = "${each.value} > ${local.t.alb_5xx_count_5m} in 5 min on the API ALB."
  namespace           = "AWS/ApplicationELB"
  metric_name         = each.value
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = local.t.alb_5xx_count_5m
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# p99, not average: averages hide the slow tail that users feel. Two of
# three 5-minute periods to avoid paging on a single GC pause.
resource "aws_cloudwatch_metric_alarm" "target_p99_latency" {
  count = var.enable_alb_alarms ? 1 : 0

  alarm_name          = "${var.name}-api-p99-latency"
  alarm_description   = "API target p99 latency > ${local.t.target_p99_latency_seconds}s."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  extended_statistic  = "p99"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = local.t.target_p99_latency_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# ---------------------------------------------------------------------
# ECS
# ---------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  for_each = var.ecs_service_names

  alarm_name          = "${var.name}-${each.key}-cpu-high"
  alarm_description   = "${each.key} average CPU > ${local.t.ecs_cpu_percent}% for 15 min (autoscaling not keeping up or at max)."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.value }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = local.t.ecs_cpu_percent
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# Memory is the one that kills Node tasks (OOM), so alarm on Maximum.
resource "aws_cloudwatch_metric_alarm" "ecs_memory" {
  for_each = var.ecs_service_names

  alarm_name          = "${var.name}-${each.key}-memory-high"
  alarm_description   = "${each.key} max memory > ${local.t.ecs_memory_percent}% (OOM risk)."
  namespace           = "AWS/ECS"
  metric_name         = "MemoryUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = local.t.ecs_memory_percent
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# ---------------------------------------------------------------------
# RDS
# ---------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name}-rds-cpu-high"
  alarm_description   = "RDS CPU > ${local.t.rds_cpu_percent}% for 15 min."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = local.t.rds_cpu_percent
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching" # no metrics from the DB is itself bad
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# Storage autoscaling should prevent this; the alarm catches the case
# where max_allocated_storage has been reached.
resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${var.name}-rds-free-storage-low"
  alarm_description   = "RDS free storage < ${local.t.rds_free_storage_bytes} bytes."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = local.t.rds_free_storage_bytes
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# Connection exhaustion is the classic failure when tasks scale out
# with per-task pools; tune with (max tasks x pool size).
resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${var.name}-rds-connections-high"
  alarm_description   = "RDS connections > ${local.t.rds_connections} (pool exhaustion risk)."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBInstanceIdentifier = var.rds_instance_identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = local.t.rds_connections
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# ---------------------------------------------------------------------
# SQS (DLQ-not-empty alarm lives in the messaging module)
# ---------------------------------------------------------------------

# Age of oldest message = consumer lag. Rising age means webhooks are
# being delivered late even if nothing has failed yet.
resource "aws_cloudwatch_metric_alarm" "sqs_oldest_message_age" {
  alarm_name          = "${var.name}-sqs-oldest-message-age"
  alarm_description   = "Oldest message in ${var.sqs_queue_name} older than ${local.t.sqs_oldest_message_age_secs}s (worker lagging or down)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = var.sqs_queue_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = local.t.sqs_oldest_message_age_secs
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}
