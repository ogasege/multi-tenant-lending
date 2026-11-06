# Unit tests: `terraform test` (from modules/messaging). mock_provider
# means no AWS credentials or cost; command = plan asserts on the
# configuration Terraform would send to AWS.

mock_provider "aws" {
  # Queue ARNs are computed; a realistic mock value lets the redrive
  # policy (which embeds the DLQ ARN) be asserted.
  mock_resource "aws_sqs_queue" {
    defaults = {
      arn = "arn:aws:sqs:af-south-1:111111111111:lending-test-domain-events-dlq"
    }
  }
  # Mocked data sources return random strings; resources that validate
  # their policy argument need syntactically valid JSON.
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

variables {
  name        = "lending-test"
  kms_key_arn = "arn:aws:kms:af-south-1:111111111111:key/00000000-0000-0000-0000-000000000000"
}

run "queues_are_kms_encrypted" {
  command = plan

  assert {
    condition     = aws_sqs_queue.this.kms_master_key_id == var.kms_key_arn
    error_message = "Main queue must use SSE-KMS with the supplied CMK."
  }

  assert {
    condition     = aws_sqs_queue.dlq.kms_master_key_id == var.kms_key_arn
    error_message = "DLQ must use SSE-KMS with the supplied CMK."
  }
}

run "names_follow_convention" {
  command = plan

  assert {
    condition     = aws_sqs_queue.this.name == "lending-test-domain-events"
    error_message = "Main queue name must be <name>-domain-events."
  }

  assert {
    condition     = aws_sqs_queue.dlq.name == "lending-test-domain-events-dlq"
    error_message = "DLQ name must be <name>-domain-events-dlq."
  }
}

# apply against the MOCK provider (no AWS calls, no cost): the redrive
# policy embeds the computed DLQ ARN, and Terraform 1.10 only applies
# mock values for computed attributes during apply.
run "dlq_after_five_receives" {
  command = apply

  assert {
    condition     = jsondecode(aws_sqs_queue.this.redrive_policy).maxReceiveCount == 5
    error_message = "Messages must move to the DLQ after 5 receives by default."
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.this.redrive_policy).deadLetterTargetArn == aws_sqs_queue.dlq.arn
    error_message = "Redrive target must be this module's DLQ."
  }

  assert {
    condition     = aws_sqs_queue.dlq.message_retention_seconds == 1209600
    error_message = "DLQ must retain messages for the 14-day maximum."
  }

  assert {
    condition     = aws_sqs_queue.this.receive_wait_time_seconds == 20
    error_message = "Main queue must use 20s long polling."
  }
}

run "tls_only_policy_on_both_queues" {
  command = plan

  assert {
    condition = alltrue([
      for k in ["main", "dlq"] : anytrue([
        for s in data.aws_iam_policy_document.tls_only[k].statement :
        s.effect == "Deny" && anytrue([for c in s.condition : c.variable == "aws:SecureTransport" && contains(c.values, "false")])
      ])
    ])
    error_message = "Both queues must deny requests where aws:SecureTransport is false."
  }
}

run "dlq_alarm_created_by_default" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.dlq_not_empty) == 1
    error_message = "DLQ-not-empty alarm must exist by default."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.dlq_not_empty[0].threshold == 0 && aws_cloudwatch_metric_alarm.dlq_not_empty[0].comparison_operator == "GreaterThanThreshold"
    error_message = "DLQ alarm must fire on the first message (depth > 0)."
  }
}

run "dlq_alarm_can_be_disabled" {
  command = plan

  variables {
    create_dlq_alarm = false
  }

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.dlq_not_empty) == 0
    error_message = "create_dlq_alarm = false must skip the alarm (LocalStack)."
  }
}

run "custom_max_receive_count" {
  command = apply

  variables {
    max_receive_count = 3
  }

  assert {
    condition     = jsondecode(aws_sqs_queue.this.redrive_policy).maxReceiveCount == 3
    error_message = "max_receive_count must flow into the redrive policy."
  }
}

run "rejects_zero_max_receive_count" {
  command = plan

  variables {
    max_receive_count = 0
  }

  expect_failures = [var.max_receive_count]
}

run "rejects_non_kms_arn" {
  command = plan

  variables {
    kms_key_arn = "alias/aws/sqs"
  }

  expect_failures = [var.kms_key_arn]
}

run "rejects_invalid_queue_name" {
  command = plan

  variables {
    queue_name = "domain events!"
  }

  expect_failures = [var.queue_name]
}

run "rejects_visibility_timeout_below_worker_budget" {
  command = plan

  variables {
    visibility_timeout_seconds = 30
  }

  expect_failures = [var.visibility_timeout_seconds]
}
