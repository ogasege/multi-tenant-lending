# prod: HA everywhere - NAT per AZ, Multi-AZ RDS, Valkey failover,
# >= 2 API tasks spread across AZs, deletion protection, DR backups.
module "platform" {
  source = "../../modules/platform"

  environment = var.environment
  dr_region   = var.dr_region

  # Created by bootstrap; the CI apply role can only create roles that
  # carry it, so nothing Terraform creates can exceed workload rights.
  permissions_boundary_arn = "arn:aws:iam::${var.aws_account_id}:policy/lending-boundary-prod"

  vpc_cidr                   = "10.40.0.0/16"
  single_nat_gateway         = false
  enable_interface_endpoints = true

  # Graviton m6g (m7g is not offered for RDS in af-south-1).
  db_instance_class          = "db.m6g.large"
  db_multi_az                = true
  db_allocated_storage       = 100
  db_max_allocated_storage   = 500
  db_backup_retention_period = 35 # maximum PITR window
  # Offshore copy of Nigerian payment data: requires legal sign-off
  # (CBN localisation circular). See README "Disaster recovery".
  enable_dr_backup_replication = true

  cache_node_type          = "cache.m6g.large"
  cache_num_nodes          = 2
  cache_automatic_failover = true

  # One-time switch for the move to write-only secrets (see README).
  preserve_existing_app_secret = var.preserve_existing_app_secret

  image_reference            = var.image_reference
  migrations_image_reference = var.migrations_image_reference

  api = {
    cpu           = 1024
    memory        = 2048
    desired_count = 2
    min_capacity  = 2
    max_capacity  = 10
  }

  worker = {
    cpu           = 512
    memory        = 1024
    desired_count = 2
    min_capacity  = 2
    max_capacity  = 6
  }

  certificate_arn         = var.certificate_arn
  platform_admin_cidrs    = var.platform_admin_cidrs
  alb_deletion_protection = true

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

  log_retention_in_days = 365
  alarm_email_endpoints = var.alarm_email_endpoints
}
