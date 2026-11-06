data "aws_availability_zones" "available" {
  # AZ names sort lexically and we take the first az_count, so a newly
  # launched AZ (next letter) never shifts existing subnets.
  #checkov:skip=CKV_AWS_394:Stable via slice(0, az_count) of sorted names
  state = "available"

  # Exclude Local Zones / Wavelength so only real regional AZs are used.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_region" "current" {}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # Deterministic carve-up of the /16 (see README for the map):
  #   public   10.x.0.0/24 .. 10.x.2.0/24   ALB + NAT only, tiny
  #   private  10.x.16.0/20 .. 10.x.48.0/20 Fargate tasks (one ENI each)
  #   database 10.x.64.0/24 .. 10.x.66.0/24 RDS + ElastiCache, no route out
  public_subnets   = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 4, i + 1)]
  database_subnets = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 64 + i)]

  interface_endpoints = var.enable_interface_endpoints ? toset([
    "ecr.api",        # image manifest / auth token
    "ecr.dkr",        # docker registry API (layers come via the S3 gateway)
    "logs",           # awslogs driver
    "secretsmanager", # secrets injected at task start
    "sqs",            # outbox relay + webhook consumer
    "kms",            # SSE-KMS data-key calls
    "sts",            # task-role credential vending / AssumeRole
  ]) : toset([])
}

# Community module, pinned to an exact version: it encodes years of
# edge cases (route tables per AZ, NAT/EIP wiring, subnet groups) that a
# hand-rolled VPC would re-learn. Exact pin = reviewed upgrades only.
module "vpc" {
  # Exact registry version pin (upgrades only via reviewed PR). Note the
  # lock file pins providers, not modules - the exact pin is the control.
  #checkov:skip=CKV_TF_1:Registry source pinned to an exact version
  source  = "terraform-aws-modules/vpc/aws"
  version = "6.7.3"

  name = var.name
  cidr = var.vpc_cidr
  azs  = local.azs

  public_subnets   = local.public_subnets
  private_subnets  = local.private_subnets
  database_subnets = local.database_subnets

  # Database subnets get their own route table with NO default route:
  # RDS/Valkey are unreachable from and cannot reach the internet.
  create_database_subnet_group           = true
  create_database_subnet_route_table     = true
  create_database_internet_gateway_route = false
  create_database_nat_gateway_route      = false

  enable_nat_gateway     = true
  single_nat_gateway     = var.single_nat_gateway
  one_nat_gateway_per_az = !var.single_nat_gateway

  enable_dns_hostnames = true # required for interface endpoint private DNS
  enable_dns_support   = true

  # Nothing should get a public IP by accident; the ALB uses its own.
  map_public_ip_on_launch = false

  # Lock down the default SG (no rules) so an ENI that forgets an SG
  # gets no connectivity instead of "allow all from self".
  manage_default_security_group  = true
  default_security_group_ingress = []
  default_security_group_egress  = []

  # Flow logs (ALL traffic) for incident forensics and to prove
  # segmentation to auditors. 60s aggregation = faster detection.
  enable_flow_log                                 = true
  create_flow_log_cloudwatch_log_group            = true
  create_flow_log_cloudwatch_iam_role             = true
  flow_log_traffic_type                           = "ALL"
  flow_log_max_aggregation_interval               = 60
  flow_log_cloudwatch_log_group_retention_in_days = var.flow_log_retention_in_days
  flow_log_cloudwatch_log_group_kms_key_id        = var.logs_kms_key_arn
  vpc_flow_log_iam_role_name                      = "${var.name}-vpc-flow-log"
  vpc_flow_log_iam_role_use_name_prefix           = false
  vpc_flow_log_permissions_boundary               = var.permissions_boundary_arn
  # Name contains "<name>" so CI's log permissions (scoped to
  # *<project>-<env>*) cover it.
  flow_log_cloudwatch_log_group_name_prefix = "/aws/vpc-flow-log/${var.name}/"
  # Deterministic "<name>-*" IAM names keep the CI apply role's IAM
  # permissions scoped to this project's prefix (see bootstrap).
  vpc_flow_log_iam_policy_name            = "${var.name}-vpc-flow-log"
  vpc_flow_log_iam_policy_use_name_prefix = false
}

# ---------------------------------------------------------------------
# VPC endpoints
# ---------------------------------------------------------------------

# Gateway endpoint is free and removes NAT data-processing charges for
# ECR image layers and branding uploads; keep it on in every env.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.vpc.vpc_id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(module.vpc.private_route_table_ids, module.vpc.database_route_table_ids)

  tags = {
    Name = "${var.name}-s3"
  }
}

resource "aws_security_group" "endpoints" {
  count = var.enable_interface_endpoints ? 1 : 0

  name        = "${var.name}-vpc-endpoints"
  description = "HTTPS from inside the VPC to interface endpoints"
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name = "${var.name}-vpc-endpoints"
  }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  count = var.enable_interface_endpoints ? 1 : 0

  security_group_id = aws_security_group.endpoints[0].id
  description       = "HTTPS from VPC"
  cidr_ipv4         = var.vpc_cidr
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Interface endpoints keep AWS API traffic (secrets, KMS, SQS) on the
# AWS network and let a future "no NAT" posture work. Flagged because
# 7 endpoints x 3 AZs is ~USD 150/month - more than dev is worth.
resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_endpoints

  vpc_id              = module.vpc.vpc_id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = module.vpc.private_subnets
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true

  tags = {
    Name = "${var.name}-${each.key}"
  }
}

# ---------------------------------------------------------------------
# Lagos Local Zone (optional, documented residency path - not built out)
# ---------------------------------------------------------------------

# The Lagos Local Zone offers EC2, EBS (gp2) and ALB only - no RDS, no
# Fargate - so an in-country data cell would be self-managed PostgreSQL
# on EC2 in this subnet. Only the network foothold is codified here so
# the residency option is concrete and plan-able; see README.
resource "aws_subnet" "lagos_local_zone" {
  count = var.enable_lagos_local_zone ? 1 : 0

  vpc_id                  = module.vpc.vpc_id
  availability_zone       = var.lagos_local_zone_name
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 128)
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name}-private-${var.lagos_local_zone_name}"
    Tier = "local-zone-data"
  }
}

# Own route table with no default route: the in-country cell talks only
# to the VPC (and the S3 gateway), never directly to the internet.
resource "aws_route_table" "lagos_local_zone" {
  count = var.enable_lagos_local_zone ? 1 : 0

  vpc_id = module.vpc.vpc_id

  tags = {
    Name = "${var.name}-private-${var.lagos_local_zone_name}"
  }
}

resource "aws_route_table_association" "lagos_local_zone" {
  count = var.enable_lagos_local_zone ? 1 : 0

  subnet_id      = aws_subnet.lagos_local_zone[0].id
  route_table_id = aws_route_table.lagos_local_zone[0].id
}
