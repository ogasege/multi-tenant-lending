data "aws_region" "current" {}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  services     = { for k, w in var.workloads : k => w if w.run_as_service }
  alb_services = { for k, w in local.services : k => w if w.attach_to_alb }
  request_scaled = {
    for k, w in local.alb_services : k => w if w.requests_per_target != null
  }

  # Only workloads that actually call AWS data-plane APIs get a task-role
  # policy (an IAM policy with zero statements is invalid anyway).
  task_policy_workloads = {
    for k, w in var.workloads : k => w
    if length(w.sqs_send_queue_arns) + length(w.sqs_consume_queue_arns) + length(w.s3_object_arns) + length(w.kms_key_arns) + length(w.dynamodb_read_table_arns) + length(w.dynamodb_write_table_arns) + length(w.dynamodb_reserve_table_arns) > 0
  }

  container_definitions = {
    for k, w in var.workloads : k => [merge(
      {
        name      = k
        image     = coalesce(w.image, var.container_image)
        essential = true

        # Non-root + read-only root FS: a compromised process cannot
        # modify the app code or drop binaries into the image layers.
        user                   = var.container_user
        readonlyRootFilesystem = true
        # Writable scratch for Node/tmp files only (ephemeral, per task).
        mountPoints = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]

        # Tiny init (tini) as PID 1: forwards SIGTERM to node and reaps
        # zombies, so enableShutdownHooks() actually runs on deploy.
        linuxParameters = { initProcessEnabled = true }

        # Time between SIGTERM and SIGKILL. The worker uses the 120s
        # maximum to finish in-flight webhook deliveries / outbox batches.
        stopTimeout = w.stop_timeout

        environment = [
          for name, value in merge(var.common_environment, w.environment) : { name = name, value = value }
        ]

        # Injected by the ECS agent at start from Secrets Manager; values
        # never appear in the task definition, console or Terraform plan.
        secrets = [
          for name, s in w.secrets : {
            name      = name
            valueFrom = s.json_key == null ? s.secret_arn : "${s.secret_arn}:${s.json_key}::"
          }
        ]

        ulimits = [{ name = "nofile", softLimit = 65536, hardLimit = 65536 }]

        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = var.log_group_names[k]
            awslogs-region        = local.region
            awslogs-stream-prefix = k
            # non-blocking: a CloudWatch Logs hiccup must not stall
            # request handling; the 25 MiB buffer absorbs bursts.
            mode            = "non-blocking"
            max-buffer-size = "25m"
          }
        }
      },
      # Omit `command` entirely to run the image's default (Flyway image).
      w.command == null ? {} : { command = w.command },
      w.container_port == null ? {} : {
        portMappings = [{ containerPort = w.container_port, protocol = "tcp", name = "http" }]
      },
      w.health_check_command == null ? {} : {
        healthCheck = {
          command     = w.health_check_command
          interval    = 15
          timeout     = 5
          retries     = 3
          startPeriod = 30
        }
      },
    )]
  }
}

# ---------------------------------------------------------------------
# Cluster
# ---------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  #checkov:skip=CKV_AWS_65:Variable-driven; validation only allows enabled or enhanced
  name = var.name

  # Container Insights gives per-service CPU/memory/network metrics used
  # by the observability alarms and autoscaling troubleshooting.
  setting {
    name  = "containerInsights"
    value = var.container_insights
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  # On-demand by default: the API and money-moving worker must not be
  # reclaimed with 2 minutes' notice. Spot is registered for future
  # non-critical batch jobs.
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}

# ---------------------------------------------------------------------
# Security groups (one per workload: least-privilege network paths)
# ---------------------------------------------------------------------

resource "aws_security_group" "task" {
  for_each = var.workloads

  name        = "${var.name}-${each.key}"
  description = "ECS tasks for ${var.name} ${each.key}"
  vpc_id      = var.vpc_id

  tags = {
    Name     = "${var.name}-${each.key}"
    Workload = each.key
  }
}

# 443 to anywhere: AWS APIs (via NAT or endpoints) and - for the worker -
# outbound webhook delivery to arbitrary tenant HTTPS endpoints (the app
# enforces the private-IP SSRF guard). DNS to the VPC resolver is not
# subject to security groups, so no port 53 rule is needed.
resource "aws_vpc_security_group_egress_rule" "https" {
  for_each = var.workloads

  security_group_id = aws_security_group.task[each.key].id
  description       = "HTTPS to AWS APIs and webhook endpoints"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "postgres" {
  for_each = var.workloads

  security_group_id = aws_security_group.task[each.key].id
  description       = "PostgreSQL inside the VPC"
  cidr_ipv4         = var.vpc_cidr_block
  from_port         = 5432
  to_port           = 5432
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "valkey" {
  for_each = var.workloads

  security_group_id = aws_security_group.task[each.key].id
  description       = "Valkey inside the VPC"
  cidr_ipv4         = var.vpc_cidr_block
  from_port         = 6379
  to_port           = 6379
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "from_alb" {
  for_each = local.alb_services

  security_group_id            = aws_security_group.task[each.key].id
  description                  = "App port from the ALB only"
  referenced_security_group_id = var.alb.security_group_id
  from_port                    = each.value.container_port
  to_port                      = each.value.container_port
  ip_protocol                  = "tcp"
}

# Lives here (not in the alb module) because this module owns the task
# SG; keeps the ALB's egress limited to the app port on the app SG.
resource "aws_vpc_security_group_egress_rule" "alb_to_task" {
  for_each = local.alb_services

  security_group_id            = var.alb.security_group_id
  description                  = "ALB to ${each.key} tasks"
  referenced_security_group_id = aws_security_group.task[each.key].id
  from_port                    = each.value.container_port
  to_port                      = each.value.container_port
  ip_protocol                  = "tcp"
}

# ---------------------------------------------------------------------
# IAM: execution role (ECS agent) - one per workload
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Confused-deputy guard: only ECS acting for THIS account may assume.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each = var.workloads

  name                 = "${var.name}-${each.key}-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "execution" {
  for_each = var.workloads

  # ecr:GetAuthorizationToken does not support resource-level
  # permissions - "*" is the only valid resource (AWS limitation).
  #checkov:skip=CKV_AWS_356:ecr:GetAuthorizationToken only supports Resource "*"
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPullThisRepoOnly"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [coalesce(each.value.ecr_repository_arn, var.ecr_repository_arn)]
  }

  statement {
    sid       = "WriteOwnLogGroup"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:${var.log_group_names[each.key]}:log-stream:*"]
  }

  # Exactly the secrets this workload injects - the API cannot read the
  # worker's (cross-tenant, worker_all policy) password and only the migrations task can read
  # the RDS master secret.
  dynamic "statement" {
    for_each = length(each.value.secrets) > 0 ? [1] : []

    content {
      sid       = "ReadOwnSecrets"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = distinct([for s in values(each.value.secrets) : s.secret_arn])
    }
  }

  dynamic "statement" {
    for_each = length(each.value.secrets_kms_key_arns) > 0 ? [1] : []

    content {
      sid       = "DecryptSecretsViaSecretsManager"
      actions   = ["kms:Decrypt"]
      resources = each.value.secrets_kms_key_arns

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${local.region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = var.workloads

  name   = "execution"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.execution[each.key].json
}

# ---------------------------------------------------------------------
# IAM: task role (the application's own AWS identity)
# ---------------------------------------------------------------------

resource "aws_iam_role" "task" {
  for_each = var.workloads

  name                 = "${var.name}-${each.key}-task"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "task" {
  for_each = local.task_policy_workloads

  dynamic "statement" {
    for_each = length(each.value.sqs_send_queue_arns) > 0 ? [1] : []

    content {
      sid       = "SqsSend"
      actions   = ["sqs:SendMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl"]
      resources = each.value.sqs_send_queue_arns
    }
  }

  dynamic "statement" {
    for_each = length(each.value.sqs_consume_queue_arns) > 0 ? [1] : []

    content {
      sid = "SqsConsume"
      actions = [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
      ]
      resources = each.value.sqs_consume_queue_arns
    }
  }

  # Object ARNs are passed as <bucket>/tenants/* - no bucket-wide access,
  # no ListBucket (tenants cannot be enumerated through this role).
  dynamic "statement" {
    for_each = length(each.value.s3_object_arns) > 0 ? [1] : []

    content {
      sid       = "S3TenantObjects"
      actions   = ["s3:GetObject", "s3:PutObject"]
      resources = each.value.s3_object_arns
    }
  }

  dynamic "statement" {
    for_each = length(each.value.dynamodb_read_table_arns) > 0 ? [1] : []

    content {
      sid       = "DirectoryRead"
      actions   = ["dynamodb:GetItem"]
      resources = each.value.dynamodb_read_table_arns
    }
  }

  # API reserves a slug at registration (conditional PutItem, DeleteItem
  # to roll back). dynamodb:LeadingKeys is NOT used: the partition key is
  # the arbitrary new slug, so there is no fixed key set to pin to; the
  # condition expression (attribute_not_exists) in the app is the guard.
  dynamic "statement" {
    for_each = length(each.value.dynamodb_reserve_table_arns) > 0 ? [1] : []

    content {
      sid       = "DirectoryReserveSlug"
      actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
      resources = each.value.dynamodb_reserve_table_arns
    }
  }

  # Worker registers/updates directory entries; ConditionCheckItem lets
  # it assert "slug not taken" inside a transaction.
  dynamic "statement" {
    for_each = length(each.value.dynamodb_write_table_arns) > 0 ? [1] : []

    content {
      sid = "DirectoryReadWrite"
      actions = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:ConditionCheckItem",
      ]
      resources = each.value.dynamodb_write_table_arns
    }
  }

  # SSE-KMS on SQS and S3 means producers need GenerateDataKey and
  # consumers need Decrypt on the specific CMKs.
  dynamic "statement" {
    for_each = length(each.value.kms_key_arns) > 0 ? [1] : []

    content {
      sid       = "KmsForSseOnNamedKeys"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = each.value.kms_key_arns
    }
  }
}

resource "aws_iam_role_policy" "task" {
  for_each = local.task_policy_workloads

  name   = "task"
  role   = aws_iam_role.task[each.key].id
  policy = data.aws_iam_policy_document.task[each.key].json
}

# ---------------------------------------------------------------------
# Task definitions
# ---------------------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  for_each = var.workloads

  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  container_definitions    = jsonencode(local.container_definitions[each.key])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  volume {
    name = "tmp"
  }

  tags = {
    Workload = each.key
  }
}

# ---------------------------------------------------------------------
# Services (api, worker) - migrations stay a one-off task definition
# ---------------------------------------------------------------------

resource "aws_ecs_service" "this" {
  for_each = local.services

  name             = each.key
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.this[each.key].arn
  desired_count    = each.value.desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  # Rolling deploy that never drops below desired capacity.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # If new tasks keep failing health checks, ECS stops the rollout and
  # returns to the last steady task definition automatically.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Spread tasks back across AZs after an AZ recovers.
  availability_zone_rebalancing = "ENABLED"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.task[each.key].id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.attach_to_alb ? [1] : []

    content {
      target_group_arn = var.alb.target_group_arn
      container_name   = each.key
      container_port   = each.value.container_port
    }
  }

  # Give Node time to boot and warm DB pools before ALB checks count.
  health_check_grace_period_seconds = each.value.attach_to_alb ? 60 : null

  # Exec off: no interactive shell into money-moving containers in
  # deployed envs. Break-glass is a one-off task with audited command.
  enable_execute_command  = false
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  tags = {
    Workload = each.key
  }

  lifecycle {
    # Autoscaling owns desired_count after creation; without this every
    # apply would reset a scaled-out service back to the baseline.
    ignore_changes = [desired_count]
  }
}

# ---------------------------------------------------------------------
# Autoscaling
# ---------------------------------------------------------------------

resource "aws_appautoscaling_target" "this" {
  for_each = local.services

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this[each.key].name}"
  min_capacity       = each.value.min_capacity
  max_capacity       = each.value.max_capacity
}

# CPU target tracking: node is single-threaded per process, so CPU is
# a good saturation proxy for both API and worker.
resource "aws_appautoscaling_policy" "cpu" {
  for_each = local.services

  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.cpu_target_percent
    scale_in_cooldown  = 300 # scale in slowly (avoid flapping)
    scale_out_cooldown = 60  # scale out fast

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# Requests per target catches I/O-bound load (waiting on Postgres) that
# CPU alone under-reports. Whichever policy wants more tasks wins.
resource "aws_appautoscaling_policy" "requests" {
  for_each = local.request_scaled

  name               = "${var.name}-${each.key}-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.this[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = each.value.requests_per_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${var.alb.arn_suffix}/${var.alb.target_group_arn_suffix}"
    }
  }
}
