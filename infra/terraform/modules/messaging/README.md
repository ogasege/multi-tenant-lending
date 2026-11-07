# messaging

This module creates the SQS **standard** queue `<name>-domain-events` and its DLQ `<name>-domain-events-dlq`.

- Redrive to the DLQ after `max_receive_count` receives (default **5**). The DLQ keeps messages 14 days, and a
  redrive-allow policy limits it to the source queue.
- SSE-KMS with the supplied CMK (required, validated) and a 300 s data-key reuse period.
- Both queues have a resource policy that **denies non-TLS** requests.
- 20 s long polling, plus a configurable visibility timeout and retention.
- A `dlq_not_empty` alarm fires on depth > 0 and notifies `alarm_actions`. Set `create_dlq_alarm = false` for
  LocalStack.

Tests: `terraform test` (`tests/messaging.tftest.hcl`, mock provider) covers encryption, naming, redrive, the TLS
policy, the alarm and variable validation.
