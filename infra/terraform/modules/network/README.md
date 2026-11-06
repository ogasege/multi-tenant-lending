# network

This module builds a VPC across 3 AZs (2 also allowed) with `terraform-aws-modules/vpc` pinned at **6.7.3**.

| Tier | CIDR (for 10.x.0.0/16) | Route | Used by |
|---|---|---|---|
| public | 10.x.0-2.0/24 | IGW | ALB, NAT gateways |
| private | 10.x.16/32/48.0/20 | NAT | Fargate tasks (one ENI per task, hence /20) |
| database | 10.x.64-66.0/24 | **none** | RDS, ElastiCache |
| Lagos LZ (optional) | 10.x.128.0/24 | none | future in-country data cell (EC2 only) |

* `single_nat_gateway` chooses between one shared NAT (dev) and one NAT per AZ (staging/prod).
* The S3 gateway endpoint is always on (it is free). The interface endpoints (ecr.api, ecr.dkr, logs,
  secretsmanager, sqs, kms, sts) sit behind `enable_interface_endpoints` (about $150/month for 7 endpoints × 3
  AZs).
* VPC flow logs capture ALL traffic at 60 s aggregation into a KMS-encrypted CloudWatch log group. The default SG
  is locked down with no rules.
* `enable_lagos_local_zone` adds an isolated subnet in `af-south-1-los-1a`. The zone group must be opted in, and
  only EC2, EBS gp2 and ALB are available there.
* The flow-log IAM role and policy are named `<name>-vpc-flow-log`, carry `permissions_boundary_arn`, and fall
  inside the CI apply role's IAM scope.

Inputs and outputs are documented in `variables.tf` and `outputs.tf`.
