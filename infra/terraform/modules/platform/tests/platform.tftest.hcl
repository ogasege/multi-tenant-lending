# Unit tests: `terraform test` (from modules/platform), no AWS access.
# Guards the API-only provider settings in the runtime contract: the
# API gets KYC/payment/bureau/checkout-order providers and the backdate
# window, the worker and migrate get none of them, and prod rejects mock.
#
# Child modules are overridden so the test exercises only this module's
# wiring (each child module has, or does not need, its own tests) and
# needs no registry download for the VPC module.

# REAL providers, offline: Terraform 1.11 mock providers cannot mock
# ephemeral resources, and the child modules have some (write-only
# secrets). Every child module is overridden, credential checks are
# skipped and this module's identity data sources are overridden, so a
# plan makes no API call. random generates values locally.
provider "aws" {
  region                      = "af-south-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
}

override_data {
  target = data.aws_region.current
  values = {
    region = "af-south-1"
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "111111111111"
  }
}

override_module {
  target = module.security
  outputs = {
    kms_key_arns = {
      secrets   = "arn:aws:kms:af-south-1:111111111111:key/secrets"
      s3        = "arn:aws:kms:af-south-1:111111111111:key/s3"
      messaging = "arn:aws:kms:af-south-1:111111111111:key/messaging"
    }
    app_secret_arn = "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-dev/app-AbCdEf"
  }
}

override_module {
  target = module.database
  outputs = {
    address                = "db.example.internal"
    port                   = 5432
    database_name          = "lending"
    app_role_name          = "lending_app"
    worker_role_name       = "lending_worker"
    app_role_secret_arn    = "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-dev/db/lending_app-AbCdEf"
    worker_role_secret_arn = "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-dev/db/lending_worker-GhIjKl"
    master_user_secret_arn = "arn:aws:secretsmanager:af-south-1:111111111111:secret:rds!db-123-XyZ"
  }
}

override_module {
  target = module.messaging
  outputs = {
    queue_url = "https://sqs.af-south-1.amazonaws.com/111111111111/lending-dev-domain-events"
    queue_arn = "arn:aws:sqs:af-south-1:111111111111:lending-dev-domain-events"
  }
}

override_module {
  target = module.storage
  outputs = {
    bucket_name        = "lending-dev-branding"
    tenant_objects_arn = "arn:aws:s3:::lending-dev-branding/tenants/*"
  }
}

override_module {
  target = module.cache
  outputs = {
    redis_secret_arn = "arn:aws:secretsmanager:af-south-1:111111111111:secret:lending-dev/redis-MnOpQr"
  }
}

override_module {
  target = module.ecr
  outputs = {
    repository_url = "111111111111.dkr.ecr.af-south-1.amazonaws.com/lending-dev/lending-core"
    repository_arn = "arn:aws:ecr:af-south-1:111111111111:repository/lending-dev/lending-core"
  }
}

override_module {
  target = module.ecr_migrations
  outputs = {
    repository_url = "111111111111.dkr.ecr.af-south-1.amazonaws.com/lending-dev/lending-migrations"
    repository_arn = "arn:aws:ecr:af-south-1:111111111111:repository/lending-dev/lending-migrations"
  }
}

override_module {
  target = module.network
}

override_module {
  target = module.alb
}

override_module {
  target = module.ecs
  outputs = {
    cluster_name         = "lending-dev"
    service_names        = { api = "lending-dev-api", worker = "lending-dev-worker" }
    task_definition_arns = { migrate = "arn:aws:ecs:af-south-1:111111111111:task-definition/lending-dev-migrate:1" }
    security_group_ids   = { api = "sg-api", worker = "sg-worker", migrate = "sg-migrate" }
  }
}

override_module {
  target = module.observability
}

variables {
  environment = "dev"
  dr_region   = "eu-west-2"

  vpc_cidr                   = "10.20.0.0/16"
  single_nat_gateway         = true
  enable_interface_endpoints = false

  db_instance_class            = "db.t4g.micro"
  db_multi_az                  = false
  db_backup_retention_period   = 3
  enable_dr_backup_replication = false

  cache_node_type          = "cache.t4g.micro"
  cache_num_nodes          = 1
  cache_automatic_failover = false

  image_reference            = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  migrations_image_reference = "sha256:1111111111111111111111111111111111111111111111111111111111111111"

  api    = { cpu = 256, memory = 512, desired_count = 1, min_capacity = 1, max_capacity = 2 }
  worker = { cpu = 256, memory = 512, desired_count = 1, min_capacity = 1, max_capacity = 1 }

  certificate_arn         = "arn:aws:acm:af-south-1:111111111111:certificate/00000000-0000-0000-0000-000000000000"
  alb_deletion_protection = false

  api_domain = "api.example.com"
  directory = {
    table_name  = "lending-dev-tenant-directory"
    kms_key_arn = "arn:aws:kms:af-south-1:111111111111:key/directory"
  }

  kyc_provider             = "mock"
  payment_provider         = "mock"
  credit_bureau_provider   = "mock"
  checkout_orders_provider = "mock"

  cors_origins = ["https://app.example.com"]
  jwt_issuer   = "https://api.example.com"
}

run "api_gets_provider_settings_worker_does_not" {
  command = plan

  assert {
    condition = alltrue([
      local.workloads.api.environment.KYC_PROVIDER == "mock",
      local.workloads.api.environment.PAYMENT_PROVIDER == "mock",
      local.workloads.api.environment.CREDIT_BUREAU_PROVIDER == "mock",
      local.workloads.api.environment.CHECKOUT_ORDERS_PROVIDER == "mock",
    ])
    error_message = "The API must receive KYC, payment, credit-bureau and checkout-order provider settings."
  }

  assert {
    condition     = local.workloads.api.environment.REPAYMENT_MAX_BACKDATE_DAYS == "3"
    error_message = "REPAYMENT_MAX_BACKDATE_DAYS must default to 3 on the API."
  }

  # Provider settings are API-only (the app enforces them for the API
  # role only); they must not leak into the shared env either, or the
  # worker and migrate would inherit them via common_environment.
  assert {
    condition = alltrue(flatten([
      for w in ["worker", "migrate"] : [
        for k in ["KYC_PROVIDER", "PAYMENT_PROVIDER", "CREDIT_BUREAU_PROVIDER", "CHECKOUT_ORDERS_PROVIDER", "REPAYMENT_MAX_BACKDATE_DAYS"] :
        !contains(keys(merge(local.common_environment, local.workloads[w].environment)), k)
      ]
    ]))
    error_message = "Provider settings and the backdate window are API-only: the worker and migrate must not get them."
  }
}

run "backdate_window_is_configurable" {
  command = plan

  variables {
    repayment_max_backdate_days = 0
  }

  assert {
    condition     = local.workloads.api.environment.REPAYMENT_MAX_BACKDATE_DAYS == "0"
    error_message = "repayment_max_backdate_days must reach the API env as a string."
  }
}

run "rejects_backdate_window_out_of_range" {
  command = plan

  variables {
    repayment_max_backdate_days = 32
  }

  expect_failures = [var.repayment_max_backdate_days]
}

run "rejects_fractional_backdate_window" {
  command = plan

  variables {
    repayment_max_backdate_days = 1.5
  }

  expect_failures = [var.repayment_max_backdate_days]
}

run "prod_rejects_mock_providers" {
  command = plan

  variables {
    environment              = "prod"
    kyc_provider             = "acme"
    payment_provider         = "mock"
    credit_bureau_provider   = "mock"
    checkout_orders_provider = "mock"
  }

  expect_failures = [
    var.payment_provider,
    var.credit_bureau_provider,
    var.checkout_orders_provider,
  ]
}

run "prod_rejects_uppercase_placeholder" {
  command = plan

  variables {
    environment              = "prod"
    kyc_provider             = "acme"
    payment_provider         = "REPLACE_WITH_REAL_PROVIDER"
    credit_bureau_provider   = "acme"
    checkout_orders_provider = "acme"
  }

  expect_failures = [var.payment_provider]
}

run "prod_accepts_real_providers" {
  command = plan

  variables {
    environment              = "prod"
    kyc_provider             = "acme"
    payment_provider         = "acme"
    credit_bureau_provider   = "acme"
    checkout_orders_provider = "acme"
  }

  assert {
    condition     = local.workloads.api.environment.PAYMENT_PROVIDER == "acme"
    error_message = "A real prod payment provider must reach the API env."
  }
}
