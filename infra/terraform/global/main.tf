# Global control plane for one environment tier (SPEC section 4.1):
#   * tenant directory (DynamoDB global table, replica per cell region)
#   * edge routing (Route 53 per-cell records + geolocation entry point)
# Apply order: global (directory) -> cells -> global again with `cells`.

locals {
  name = "lending-${var.environment}"
}

module "directory" {
  source = "../modules/directory"

  table_name       = "${local.name}-tenant-directory"
  cell_regions     = var.cell_regions
  kms_alias_prefix = "alias/${local.name}-directory"
}

module "edge" {
  source = "../modules/edge"
  count  = length(var.cells) > 0 ? 1 : 0

  name           = local.name
  hosted_zone_id = var.hosted_zone_id
  api_domain     = var.api_domain
  cells          = var.cells
  default_region = var.aws_region

  # Health checks only in prod: their IAM actions cannot be scoped to an
  # environment, so only the prod apply role may create/update/delete them.
  enable_health_checks = var.environment == "prod"
}
