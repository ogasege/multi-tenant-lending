# dev: cheapest topology that still exercises every component. Sizes
# live here (reviewed code), not in tfvars, so env drift shows in diffs.
module "platform" {
  source = "../../modules/platform"

  environment = var.environment
  dr_region   = var.dr_region

  # Created by bootstrap; the CI apply role can only create roles that
  # carry it, so nothing Terraform creates can exceed workload rights.
  permissions_boundary_arn = "arn:aws:iam::${var.aws_account_id}:policy/lending-boundary-dev"

  # Network: one NAT (an AZ outage takes dev egress down - acceptable),
  # no interface endpoints (~USD 150/month saved; traffic uses NAT).
  vpc_cidr                   = "10.20.0.0/16"
  single_nat_gateway         = true
  enable_interface_endpoints = false

  # Database: single-AZ burstable, short PITR window, no DR copy.
  db_instance_class            = "db.t4g.micro"
  db_multi_az                  = false
  db_allocated_storage         = 20
  db_max_allocated_storage     = 50
  db_backup_retention_period   = 3
  enable_dr_backup_replication = false

  # Cache: single node, no failover.
  cache_node_type          = "cache.t4g.micro"
  cache_num_nodes          = 1
  cache_automatic_failover = false

  # One-time switch for the move to write-only secrets (see README).
  preserve_existing_app_secret = var.preserve_existing_app_secret

  image_reference            = var.image_reference
  migrations_image_reference = var.migrations_image_reference

  api = {
    cpu           = 256
    memory        = 512
    desired_count = 1
    min_capacity  = 1
    max_capacity  = 2
  }

  worker = {
    cpu           = 256
    memory        = 512
    desired_count = 1
    min_capacity  = 1
    max_capacity  = 1
  }

  certificate_arn         = var.certificate_arn
  platform_admin_cidrs    = var.platform_admin_cidrs
  alb_deletion_protection = false

  api_domain = var.api_domain
  directory = {
    table_name  = var.directory_table_name
    kms_key_arn = var.directory_kms_key_arn
  }

  kyc_provider             = var.kyc_provider
  payment_provider         = var.payment_provider
  credit_bureau_provider   = var.credit_bureau_provider
  checkout_orders_provider = var.checkout_orders_provider

  cors_origins = var.cors_origins
  jwt_issuer   = var.jwt_issuer
  log_level    = "debug"

  log_retention_in_days          = 14
  alarm_email_endpoints          = var.alarm_email_endpoints
  kms_deletion_window_in_days    = 7
  secret_recovery_window_in_days = 7
}
