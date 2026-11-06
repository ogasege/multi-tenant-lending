# staging: SAME topology as prod (Multi-AZ, NAT per AZ, endpoints, WAF,
# >= 2 API tasks, deletion protection, DR copy) on smaller instances.
# Used for migration rehearsal against prod-shaped infra, partner
# institution UAT/sandbox (webhooks, branding) and release-candidate
# verification of the exact image digest that will go to prod.
module "platform" {
  source = "../../modules/platform"

  environment = var.environment
  dr_region   = var.dr_region

  # Created by bootstrap; the CI apply role can only create roles that
  # carry it, so nothing Terraform creates can exceed workload rights.
  permissions_boundary_arn = "arn:aws:iam::${var.aws_account_id}:policy/lending-boundary-staging"

  vpc_cidr                   = "10.30.0.0/16"
  single_nat_gateway         = false
  enable_interface_endpoints = true

  # db.m7g is not offered for RDS in af-south-1; t4g/m6g are.
  db_instance_class          = "db.t4g.medium"
  db_multi_az                = true
  db_allocated_storage       = 20
  db_max_allocated_storage   = 100
  db_backup_retention_period = 7
  # On so DR restore drills run against synthetic UAT data, never prod.
  enable_dr_backup_replication = true

  cache_node_type          = "cache.t4g.small"
  cache_num_nodes          = 2
  cache_automatic_failover = true

  image_reference            = var.image_reference
  migrations_image_reference = var.migrations_image_reference

  api = {
    cpu           = 512
    memory        = 1024
    desired_count = 2
    min_capacity  = 2
    max_capacity  = 4
  }

  worker = {
    cpu           = 512
    memory        = 1024
    desired_count = 1
    min_capacity  = 1
    max_capacity  = 2
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

  log_retention_in_days = 30
  alarm_email_endpoints = var.alarm_email_endpoints
}
