# Unit tests: `terraform test` (from modules/ecs-service), no AWS access.
# Guards the least-privilege secret split and container hardening.

mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "af-south-1"
    }
  }
}

variables {
  name               = "lending-test"
  vpc_id             = "vpc-12345678"
  vpc_cidr_block     = "10.20.0.0/16"
  subnet_ids         = ["subnet-1", "subnet-2"]
  container_image    = "111111111111.dkr.ecr.af-south-1.amazonaws.com/lending-test/lending-core@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  ecr_repository_arn = "arn:aws:ecr:af-south-1:111111111111:repository/lending-test/lending-core"
  log_group_names    = { api = "/ecs/lending-test/api", worker = "/ecs/lending-test/worker", migrate = "/ecs/lending-test/migrate" }

  alb = {
    security_group_id       = "sg-alb"
    target_group_arn        = "arn:aws:elasticloadbalancing:af-south-1:111111111111:targetgroup/lending-test-api/abc"
    arn_suffix              = "app/lending-test-api/abc"
    target_group_arn_suffix = "targetgroup/lending-test-api/abc"
  }

  workloads = {
    api = {
      command        = ["dist/main.js"]
      cpu            = 256
      memory         = 512
      attach_to_alb  = true
      container_port = 3000
      secrets = {
        DATABASE_APP_PASSWORD = { secret_arn = "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-test/db/lending_app-AbCdEf", json_key = "password" }
      }
      s3_object_arns              = ["arn:aws:s3:::lending-test-branding/tenants/*"]
      kms_key_arns                = ["arn:aws:kms:af-south-1:111111111111:key/s3"]
      dynamodb_reserve_table_arns = ["arn:aws:dynamodb:af-south-1:111111111111:table/lending-test-tenant-directory"]
    }
    worker = {
      command      = ["dist/worker.js"]
      cpu          = 256
      memory       = 512
      stop_timeout = 120
      secrets = {
        DATABASE_WORKER_PASSWORD = { secret_arn = "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-test/db/lending_worker-GhIjKl", json_key = "password" }
        DATABASE_APP_PASSWORD    = { secret_arn = "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-test/db/lending_app-AbCdEf", json_key = "password" }
      }
      sqs_send_queue_arns       = ["arn:aws:sqs:af-south-1:111111111111:lending-test-domain-events"]
      sqs_consume_queue_arns    = ["arn:aws:sqs:af-south-1:111111111111:lending-test-domain-events"]
      dynamodb_write_table_arns = ["arn:aws:dynamodb:af-south-1:111111111111:table/lending-test-tenant-directory"]
      kms_key_arns              = ["arn:aws:kms:af-south-1:111111111111:key/messaging"]
    }
    migrate = {
      # Flyway image (default CMD = migrate), pinned by digest.
      image              = "111111111111.dkr.ecr.af-south-1.amazonaws.com/lending-test/lending-migrations@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      ecr_repository_arn = "arn:aws:ecr:af-south-1:111111111111:repository/lending-test/lending-migrations"
      cpu                = 512
      memory             = 1024
      run_as_service     = false
      desired_count      = 0
      min_capacity       = 0
      max_capacity       = 0
      secrets = {
        DATABASE_MIGRATOR_PASSWORD = { secret_arn = "arn:aws:secretsmanager:af-south-1:111111111111:secret:rds!db-123-XyZ", json_key = "password" }
      }
    }
  }
}

run "secret_split_is_least_privilege" {
  command = plan

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.execution["api"].statement :
      !contains(coalesce(s.resources, []), "arn:aws:secretsmanager:af-south-1:111111111111:secret:rds!db-123-XyZ")
    ])
    error_message = "The API execution role must never be able to read the RDS master secret."
  }

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.execution["migrate"].statement :
      contains(coalesce(s.resources, []), "arn:aws:secretsmanager:af-south-1:111111111111:secret:rds!db-123-XyZ")
    ])
    error_message = "The migrations execution role must be able to read the RDS master secret."
  }
}

run "worker_gets_worker_and_app_roles_but_not_master" {
  command = plan

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.execution["worker"].statement :
      s.sid == "ReadOwnSecrets" && s.resources == toset([
        "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-test/db/lending_worker-GhIjKl",
        "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-test/db/lending_app-AbCdEf",
      ])
    ])
    error_message = "The worker must read exactly the lending_worker and lending_app secrets."
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.execution["worker"].statement :
      !contains(coalesce(s.resources, []), "arn:aws:secretsmanager:af-south-1:111111111111:secret:rds!db-123-XyZ")
    ])
    error_message = "The worker must never read the RDS master secret."
  }
}

run "worker_runtime" {
  command = plan

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this["worker"].container_definitions)[0].stopTimeout >= 60
    error_message = "Worker needs >= 60 s to drain."
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_ecs_task_definition.this["worker"].container_definitions)[0]), "healthCheck")
    error_message = "Worker has no HTTP health check (process-based: essential container)."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this["worker"].container_definitions)[0].essential
    error_message = "Worker container must be essential."
  }

  assert {
    condition     = length(aws_ecs_service.this["worker"].load_balancer) == 0
    error_message = "Worker must not be attached to the ALB."
  }

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.task["worker"].statement :
      s.sid == "SqsConsume" && length(setsubtract(["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], s.actions)) == 0
    ]) && anytrue([for s in data.aws_iam_policy_document.task["worker"].statement : s.sid == "SqsSend" && contains(s.actions, "sqs:SendMessage")])
    error_message = "Worker task role needs send/receive/delete/change-visibility/attributes on the queue."
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.https["worker"].from_port == 443 && aws_vpc_security_group_egress_rule.https["worker"].cidr_ipv4 == "0.0.0.0/0"
    error_message = "Worker needs 443 egress to any destination for webhook delivery."
  }
}

run "task_role_has_no_wildcard_resources" {
  command = plan

  assert {
    condition = alltrue(flatten([
      for s in data.aws_iam_policy_document.task["api"].statement : [for r in s.resources : !endswith(r, ":*") && r != "*"]
    ]))
    error_message = "Task role statements must name specific resources."
  }

  assert {
    condition     = !contains(keys(data.aws_iam_policy_document.task), "migrate")
    error_message = "The migrations task role needs no AWS data-plane permissions."
  }
}

run "api_directory_access_is_slug_reservation_only" {
  command = plan

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.task["api"].statement :
      s.sid == "DirectoryReserveSlug" && toset(s.actions) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]) &&
      toset(s.resources) == toset(["arn:aws:dynamodb:af-south-1:111111111111:table/lending-test-tenant-directory"])
    ])
    error_message = "The API may only Get/Put/Delete items on its own region's directory replica."
  }
}

run "rejects_localstack_endpoint_on_deployed_tasks" {
  command = plan

  variables {
    common_environment = { AWS_ENDPOINT_URL = "http://localhost:4566" }
  }

  expect_failures = [var.common_environment]
}

run "rejects_plaintext_database" {
  command = plan

  variables {
    common_environment = { DATABASE_SSL = "false" }
  }

  expect_failures = [var.common_environment]
}

run "migrate_uses_flyway_image" {
  command = plan

  assert {
    condition     = startswith(jsondecode(aws_ecs_task_definition.this["migrate"].container_definitions)[0].image, "111111111111.dkr.ecr.af-south-1.amazonaws.com/lending-test/lending-migrations@sha256:")
    error_message = "migrate must run the migrations image pinned by digest."
  }

  assert {
    condition     = !contains(keys(jsondecode(aws_ecs_task_definition.this["migrate"].container_definitions)[0]), "command")
    error_message = "migrate must use the image's default command."
  }

  assert {
    condition = anytrue([
      for s in data.aws_iam_policy_document.execution["migrate"].statement :
      s.sid == "EcrPullThisRepoOnly" && s.resources == toset(["arn:aws:ecr:af-south-1:111111111111:repository/lending-test/lending-migrations"])
    ])
    error_message = "migrate's execution role may pull only from the migrations repository."
  }
}

run "rejects_image_override_without_repo" {
  command = plan

  variables {
    workloads = {
      api = {
        command = ["dist/main.js"]
        cpu     = 256
        memory  = 512
        image   = "example.com/x@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      }
    }
  }

  expect_failures = [var.workloads]
}

run "container_hardening" {
  command = plan

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this["api"].container_definitions)[0].readonlyRootFilesystem == true
    error_message = "Root filesystem must be read-only."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.this["api"].container_definitions)[0].user == "65532:65532"
    error_message = "Containers must run as the distroless non-root user."
  }

  # Distroless ENTRYPOINT is /nodejs/bin/node: the command must be the
  # script only, never ["node", ...].
  assert {
    condition     = jsondecode(aws_ecs_task_definition.this["api"].container_definitions)[0].command == ["dist/main.js"]
    error_message = "api command must be [\"dist/main.js\"] (ENTRYPOINT already is node)."
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.this["api"].container_definitions)[0].secrets[0].valueFrom
      == "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-test/db/lending_app-AbCdEf:password::"
    )
    error_message = "Secrets must be injected by JSON key from Secrets Manager."
  }
}

run "deployment_safety" {
  command = plan

  assert {
    condition     = aws_ecs_service.this["api"].deployment_circuit_breaker[0].enable && aws_ecs_service.this["api"].deployment_circuit_breaker[0].rollback
    error_message = "Deployment circuit breaker with rollback must be enabled."
  }

  assert {
    condition     = !contains(keys(aws_ecs_service.this), "migrate")
    error_message = "Migrations must be a one-off task definition, not a service."
  }
}

run "rejects_root_user" {
  command = plan

  variables {
    container_user = "0:0"
  }

  expect_failures = [var.container_user]
}

run "rejects_invalid_fargate_size" {
  command = plan

  variables {
    workloads = {
      api = {
        command = ["dist/main.js"]
        cpu     = 256
        memory  = 4096
      }
    }
  }

  expect_failures = [var.workloads]
}
