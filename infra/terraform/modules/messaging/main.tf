locals {
  queue_name = "${var.name}-${var.queue_name}"

  # Reuse a data key for 5 minutes: cuts KMS calls (and cost) by orders
  # of magnitude at the price of a 5-minute key-reuse window.
  kms_data_key_reuse_period_seconds = 300
}

# Standard (not FIFO) queue: the outbox gives ordering per aggregate and
# consumers are idempotent (webhook-id), so FIFO's 300 TPS/group limits
# and cost buy nothing here.
resource "aws_sqs_queue" "dlq" {
  name                              = "${local.queue_name}-dlq"
  message_retention_seconds         = 1209600 # 14 days (max): time to triage
  kms_master_key_id                 = var.kms_key_arn
  kms_data_key_reuse_period_seconds = local.kms_data_key_reuse_period_seconds
}

resource "aws_sqs_queue" "this" {
  name                              = local.queue_name
  visibility_timeout_seconds        = var.visibility_timeout_seconds
  message_retention_seconds         = var.message_retention_seconds
  receive_wait_time_seconds         = 20 # long polling: fewer empty receives
  kms_master_key_id                 = var.kms_key_arn
  kms_data_key_reuse_period_seconds = local.kms_data_key_reuse_period_seconds

  # Poison messages move aside after N attempts instead of blocking the
  # consumer or being lost when retention expires.
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# Only our main queue may use this DLQ (prevents accidental sharing and
# makes redrive-to-source unambiguous).
resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.this.arn]
  })
}

data "aws_iam_policy_document" "tls_only" {
  for_each = {
    main = aws_sqs_queue.this.arn
    dlq  = aws_sqs_queue.dlq.arn
  }

  # Resource policy denies any request not made over TLS, regardless of
  # what an IAM policy elsewhere allows.
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [each.value]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sqs_queue_policy" "this" {
  for_each = {
    main = aws_sqs_queue.this.id
    dlq  = aws_sqs_queue.dlq.id
  }

  queue_url = each.value
  policy    = data.aws_iam_policy_document.tls_only[each.key].json
}

# Any message in the DLQ means a webhook could not be delivered after
# all retries - a tenant-visible failure, so page on the first one.
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  count = var.create_dlq_alarm ? 1 : 0

  alarm_name          = "${aws_sqs_queue.dlq.name}-not-empty"
  alarm_description   = "Messages in ${aws_sqs_queue.dlq.name}: events failed ${var.max_receive_count} deliveries. Inspect, fix, then redrive."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
  ok_actions          = var.alarm_actions
}
