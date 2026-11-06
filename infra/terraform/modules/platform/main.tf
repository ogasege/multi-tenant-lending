data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  # A cell = one full, share-nothing deployment of this composition in
  # one region (see README "Cells / multi-region").
  name       = var.cell_id == "" ? "${var.project}-${var.environment}" : "${var.project}-${var.environment}-${var.cell_id}"
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id

  container_image = (
    startswith(var.image_reference, "sha256:")
    ? "${module.ecr.repository_url}@${var.image_reference}"
    : "${module.ecr.repository_url}:${var.image_reference}"
  )

  migrations_image = (
    startswith(var.migrations_image_reference, "sha256:")
    ? "${module.ecr_migrations.repository_url}@${var.migrations_image_reference}"
    : "${module.ecr_migrations.repository_url}:${var.migrations_image_reference}"
  )

  kms = module.security.kms_key_arns

  # This cell's own replica of the global tenant directory - never
  # another region's ARN, so a cell cannot write other cells' replicas
  # directly (replication does that).
  directory_table_arn = "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${var.directory.table_name}"

  # Non-secret runtime contract (SPEC section 12) shared by every process.
  # AWS_ENDPOINT_URL is deliberately absent: it is set only for LocalStack.
  common_environment = merge({
    NODE_ENV      = "production"
    PORT          = "3000"
    LOG_LEVEL     = var.log_level
    DATABASE_HOST = module.database.address
    DATABASE_PORT = tostring(module.database.port)
    DATABASE_NAME = module.database.database_name
    DATABASE_SSL  = "true"
    AWS_REGION    = local.region
    # The app refuses to register institutions whose home region differs
    # from the cell it runs in (tenant pinning, SPEC section 4.1).
    CELL_REGION                 = local.region
    CELL_API_BASE_URL           = "https://${local.region}.${var.api_domain}"
    DIRECTORY_TABLE_NAME        = var.directory.table_name
    SQS_DOMAIN_EVENTS_QUEUE_URL = module.messaging.queue_url
    S3_BRANDING_BUCKET          = module.storage.bucket_name
    CORS_ORIGINS                = join(",", var.cors_origins)
    JWT_ISSUER                  = var.jwt_issuer
    # Cross-cell redirects (307/421) may only target our own cells; the
    # app requires one of these in production. The suffix matches the
    # edge module's <region>.<api_domain> records.
    CELL_ORIGIN_SUFFIX = ".${var.api_domain}"
    # Rate limits (staff vs customer principals; signup per IP).
    RATE_LIMIT_TENANT_STAFF_PER_MINUTE    = tostring(var.rate_limits.tenant_staff_per_minute)
    RATE_LIMIT_TENANT_CUSTOMER_PER_MINUTE = tostring(var.rate_limits.tenant_customer_per_minute)
    SIGNUP_RATE_LIMIT_PER_HOUR            = tostring(var.rate_limits.signup_per_hour)
    }, length(var.cell_origins) == 0 ? {} : {
    CELL_ORIGINS = jsonencode(var.cell_origins)
  })

  app_secret = module.security.app_secret_arn

  # Application keys used by both long-running processes (the shared
  # zod env schema validates them at boot in either entrypoint).
  app_key_secrets = {
    JWT_SECRET          = { secret_arn = local.app_secret, json_key = "jwt_secret" }
    BVN_HMAC_KEY        = { secret_arn = local.app_secret, json_key = "bvn_hmac_key" }
    DATA_ENCRYPTION_KEY = { secret_arn = local.app_secret, json_key = "data_encryption_key" }
    REDIS_URL           = { secret_arn = module.cache.redis_secret_arn, json_key = "url" }
  }

  # Least-privilege secret split (see README "Database credentials"):
  #   api     -> lending_app password only (RLS enforced)
  #   worker  -> lending_worker (NOBYPASSRLS; cross-tenant only via its
  #              explicit worker_all RLS policy) for outbox relay / EOD,
  #              PLUS lending_app (RLS-enforced) for tenant-scoped reads,
  #              so per-tenant work runs under normal RLS.
  #   migrate -> RDS master (schema owner, DDL) + both role passwords,
  #              because Flyway's db/callbacks/beforeMigrate.sql creates/ALTERs
  #              those login roles. Only migrate can read the master.
  workloads = {
    api = {
      # Distroless runtime: ENTRYPOINT is /nodejs/bin/node, so the
      # command is only the script (["node", ...] would run node node ...).
      command             = ["dist/main.js"]
      cpu                 = var.api.cpu
      memory              = var.api.memory
      desired_count       = var.api.desired_count
      min_capacity        = var.api.min_capacity
      max_capacity        = var.api.max_capacity
      requests_per_target = var.api.requests_per_target
      attach_to_alb       = true
      container_port      = 3000
      # Container check = liveness (process up); the ALB checks
      # readiness (/health/ready). A DB blip should drain traffic, not
      # make ECS kill and restart every task at once.
      # Exec form (CMD, not CMD-SHELL): distroless has no /bin/sh.
      health_check_command = [
        "CMD",
        "/nodejs/bin/node",
        "-e",
        "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ]
      stop_timeout = 30
      environment = {
        DATABASE_APP_USER = module.database.app_role_name
        # API only (the worker calls none of these providers). "mock" is
        # refused by the app in production.
        KYC_PROVIDER             = var.kyc_provider
        PAYMENT_PROVIDER         = var.payment_provider
        CREDIT_BUREAU_PROVIDER   = var.credit_bureau_provider
        CHECKOUT_ORDERS_PROVIDER = var.checkout_orders_provider
        # ECS env values are strings; the app coerces it back to a number.
        REPAYMENT_MAX_BACKDATE_DAYS = tostring(var.repayment_max_backdate_days)
      }
      secrets = merge(local.app_key_secrets, {
        DATABASE_APP_PASSWORD = { secret_arn = module.database.app_role_secret_arn, json_key = "password" }
      })
      secrets_kms_key_arns = [local.kms["secrets"]]
      # Presigned PUT/GET URLs are signed with the task role, so it
      # needs object access (tenant prefix only) + the bucket CMK.
      s3_object_arns = [module.storage.tenant_objects_arn]
      # Slug reservation at registration: conditional PutItem / DeleteItem
      # (rollback) + GetItem on this cell's replica only.
      dynamodb_reserve_table_arns = [local.directory_table_arn]
      kms_key_arns                = [local.kms["s3"], var.directory.kms_key_arn]
    }

    worker = {
      command       = ["dist/worker.js"]
      cpu           = var.worker.cpu
      memory        = var.worker.memory
      desired_count = var.worker.desired_count
      min_capacity  = var.worker.min_capacity
      max_capacity  = var.worker.max_capacity
      # Max Fargate grace (>= 60 s required) so in-flight webhook
      # deliveries and outbox batches drain before SIGKILL.
      stop_timeout = 120
      # No health_check_command: the worker serves no HTTP. It is an
      # essential container, so ECS replaces the task if the process exits;
      # no ALB attachment.
      environment = {
        DATABASE_WORKER_USER = module.database.worker_role_name
        DATABASE_APP_USER    = module.database.app_role_name
      }
      secrets = merge(local.app_key_secrets, {
        DATABASE_WORKER_PASSWORD = { secret_arn = module.database.worker_role_secret_arn, json_key = "password" }
        DATABASE_APP_PASSWORD    = { secret_arn = module.database.app_role_secret_arn, json_key = "password" }
      })
      secrets_kms_key_arns      = [local.kms["secrets"]]
      sqs_send_queue_arns       = [module.messaging.queue_arn]
      sqs_consume_queue_arns    = [module.messaging.queue_arn]
      dynamodb_write_table_arns = [local.directory_table_arn]
      kms_key_arns              = [local.kms["messaging"], var.directory.kms_key_arn]
    }

    migrate = {
      # Flyway image (db/Dockerfile); its default command is `migrate`.
      # It bundles the RDS CA for sslmode=verify-full (DATABASE_SSL_ROOT_CERT
      # can override the path).
      image              = local.migrations_image
      ecr_repository_arn = module.ecr_migrations.repository_arn
      cpu                = var.migrate.cpu
      memory             = var.migrate.memory
      run_as_service     = false
      desired_count      = 0
      min_capacity       = 0
      max_capacity       = 0
      stop_timeout       = 120
      environment = {
        DATABASE_APP_USER    = module.database.app_role_name
        DATABASE_WORKER_USER = module.database.worker_role_name
      }
      secrets = {
        DATABASE_MIGRATOR_USER     = { secret_arn = module.database.master_user_secret_arn, json_key = "username" }
        DATABASE_MIGRATOR_PASSWORD = { secret_arn = module.database.master_user_secret_arn, json_key = "password" }
        DATABASE_APP_PASSWORD      = { secret_arn = module.database.app_role_secret_arn, json_key = "password" }
        DATABASE_WORKER_PASSWORD   = { secret_arn = module.database.worker_role_secret_arn, json_key = "password" }
      }
      secrets_kms_key_arns = [local.kms["secrets"]]
    }
  }
}

module "security" {
  source = "../security"

  name                           = local.name
  kms_deletion_window_in_days    = var.kms_deletion_window_in_days
  waf_rate_limit_per_ip          = var.waf_rate_limit_per_ip
  waf_auth_rate_limit_per_ip     = var.waf_auth_rate_limit_per_ip
  platform_admin_cidrs           = var.platform_admin_cidrs
  log_retention_in_days          = var.log_retention_in_days
  secret_recovery_window_in_days = var.secret_recovery_window_in_days
}

module "network" {
  source = "../network"

  name                       = local.name
  vpc_cidr                   = var.vpc_cidr
  single_nat_gateway         = var.single_nat_gateway
  enable_interface_endpoints = var.enable_interface_endpoints
  enable_lagos_local_zone    = var.enable_lagos_local_zone
  flow_log_retention_in_days = var.log_retention_in_days
  logs_kms_key_arn           = local.kms["logs"]
  permissions_boundary_arn   = var.permissions_boundary_arn
}

module "ecr" {
  source = "../ecr"

  repository_name = "${local.name}/lending-core"
  kms_key_arn     = local.kms["ecr"]
}

# Separate repository for the Flyway migrations image: different build
# context (db/), different release cadence, and the API/worker execution
# roles cannot pull it (nor vice versa).
module "ecr_migrations" {
  source = "../ecr"

  repository_name = "${local.name}/lending-migrations"
  kms_key_arn     = local.kms["ecr"]
}

module "messaging" {
  source = "../messaging"

  name = local.name
  # Must exceed the worker's longest webhook delivery attempt, or SQS
  # redelivers a message that is still being processed (duplicates).
  visibility_timeout_seconds = 60
  kms_key_arn                = local.kms["messaging"]
  alarm_actions              = [module.observability.alarm_topic_arn]
}

module "storage" {
  source = "../storage"

  bucket_name          = "${local.name}-branding-${local.account_id}"
  kms_key_arn          = local.kms["s3"]
  cors_allowed_origins = var.cors_origins
}

module "database" {
  source = "../database"

  name                                   = local.name
  vpc_id                                 = module.network.vpc_id
  db_subnet_group_name                   = module.network.database_subnet_group_name
  instance_class                         = var.db_instance_class
  allocated_storage                      = var.db_allocated_storage
  max_allocated_storage                  = var.db_max_allocated_storage
  multi_az                               = var.db_multi_az
  backup_retention_period                = var.db_backup_retention_period
  deletion_protection                    = var.environment != "dev"
  skip_final_snapshot                    = false
  rds_kms_key_arn                        = local.kms["rds"]
  secrets_kms_key_arn                    = local.kms["secrets"]
  logs_kms_key_arn                       = local.kms["logs"]
  log_retention_in_days                  = var.log_retention_in_days
  enable_cross_region_backup_replication = var.enable_dr_backup_replication
  dr_region                              = var.dr_region
  secret_recovery_window_in_days         = var.secret_recovery_window_in_days
  permissions_boundary_arn               = var.permissions_boundary_arn

  allowed_security_group_ids = module.ecs.security_group_ids
}

module "cache" {
  source = "../cache"

  name                           = local.name
  vpc_id                         = module.network.vpc_id
  subnet_ids                     = module.network.database_subnet_ids
  node_type                      = var.cache_node_type
  num_cache_clusters             = var.cache_num_nodes
  automatic_failover_enabled     = var.cache_automatic_failover
  kms_key_arn                    = local.kms["elasticache"]
  secrets_kms_key_arn            = local.kms["secrets"]
  logs_kms_key_arn               = local.kms["logs"]
  log_retention_in_days          = var.log_retention_in_days
  secret_recovery_window_in_days = var.secret_recovery_window_in_days

  # The migrations task never talks to Valkey.
  allowed_security_group_ids = {
    for k, v in module.ecs.security_group_ids : k => v if k != "migrate"
  }
}

module "alb" {
  source = "../alb"

  name                = local.name
  vpc_id              = module.network.vpc_id
  public_subnet_ids   = module.network.public_subnet_ids
  certificate_arn     = var.certificate_arn
  deletion_protection = var.alb_deletion_protection
  associate_waf       = true
  web_acl_arn         = module.security.web_acl_arn
}

module "ecs" {
  source = "../ecs-service"

  name               = local.name
  vpc_id             = module.network.vpc_id
  vpc_cidr_block     = module.network.vpc_cidr_block
  subnet_ids         = module.network.private_subnet_ids
  container_image    = local.container_image
  ecr_repository_arn = module.ecr.repository_arn
  cpu_architecture   = var.cpu_architecture
  container_insights = var.container_insights
  common_environment = local.common_environment
  log_group_names    = module.observability.log_group_names
  workloads          = local.workloads

  permissions_boundary_arn = var.permissions_boundary_arn

  alb = {
    security_group_id       = module.alb.security_group_id
    target_group_arn        = module.alb.target_group_arn
    arn_suffix              = module.alb.arn_suffix
    target_group_arn_suffix = module.alb.target_group_arn_suffix
  }
}

module "observability" {
  source = "../observability"

  name                    = local.name
  workloads               = toset(keys(local.workloads))
  log_retention_in_days   = var.log_retention_in_days
  logs_kms_key_arn        = local.kms["logs"]
  sns_kms_key_arn         = local.kms["messaging"]
  alarm_email_endpoints   = var.alarm_email_endpoints
  ecs_cluster_name        = module.ecs.cluster_name
  ecs_service_names       = module.ecs.service_names
  enable_alb_alarms       = true
  alb_arn_suffix          = module.alb.arn_suffix
  target_group_arn_suffix = module.alb.target_group_arn_suffix
  rds_instance_identifier = module.database.instance_identifier
  sqs_queue_name          = module.messaging.queue_name
  thresholds              = var.alarm_thresholds
}
