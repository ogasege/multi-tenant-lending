# ecs-service

Creates an ECS cluster (Container Insights `enabled` or `enhanced`; `disabled` is rejected) plus, for each entry in
`workloads`. Workloads share `container_image` unless they set `image` together with `ecr_repository_arn` (for
example the Flyway migrations image). `command` is optional: when it is null, the image default runs.

- A **task definition** (Fargate, ARM64 by default): non-root `65532:65532` (distroless), `readonlyRootFilesystem` with a
  writable `/tmp`, `initProcessEnabled`, `stopTimeout`, the awslogs driver in non-blocking mode, and an optional
  container health check. Secrets are injected via `secrets[].valueFrom = "<arn>:<json_key>::"`.
- An **execution role** that may pull from **one** ECR repository, write to its own log group and read **only the
  secret ARNs listed in that workload's `secrets`**, plus `kms:Decrypt` through Secrets Manager.
  `ecr:GetAuthorizationToken` is the only `"*"`, because AWS offers no resource-level permission for it.
- A **task role** with optional statements for SQS send and consume on named queues, S3 Get and Put on named
  object ARNs (tenant prefix), and KMS on named keys. There are no wildcards. A workload with no data-plane needs
  (migrate) gets no policy.
- A **security group** per workload: egress 443 anywhere, plus 5432 and 6379 within the VPC CIDR. Ingress comes
  from the ALB SG only for `attach_to_alb` workloads, and the matching ALB egress rule is created here.
- If `run_as_service` is true (the default), a **service** with rolling deploys (100/200), a circuit breaker with
  rollback, AZ rebalancing, no public IP, ECS Exec off and `ignore_changes = [desired_count]`. Autoscaling uses
  CPU target tracking, plus ALB `RequestCountPerTarget` when `requests_per_target` is set. With
  `run_as_service = false` the module creates only the task definition (used for migrations through
  `aws ecs run-task`).
- All roles carry `permissions_boundary_arn`.

Tests: `terraform test` (`tests/ecs_service.tftest.hcl`) covers the secret split (the API cannot read the master
secret), no wildcard task-role resources, container hardening, the circuit breaker and validation.
