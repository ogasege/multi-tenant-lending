# observability

- KMS-encrypted application log groups `/ecs/<name>/<workload>` with retention, created before the tasks run.
- **SaaS lens:** a metric filter `ErrorsByTenant` (pino `level >= 50`, dimension `TenantId`) and a saved Logs
  Insights query, "errors by tenant".
- An SNS topic (KMS) for all alarms, with optional email subscriptions.
- Alarms: ALB ELB and target 5xx, target **p99** latency, ECS CPU and memory per service, RDS CPU, free storage
  and connections, and SQS age of oldest message. (DLQ depth > 0 lives in the messaging module and uses this
  topic.) Thresholds can be overridden through `thresholds`.
