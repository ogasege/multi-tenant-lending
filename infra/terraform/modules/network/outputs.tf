output "vpc_id" {
  description = "ID of the VPC."
  value       = module.vpc.vpc_id
}

output "vpc_cidr_block" {
  description = "IPv4 CIDR of the VPC."
  value       = module.vpc.vpc_cidr_block
}

output "azs" {
  description = "Availability Zones in use."
  value       = local.azs
}

output "public_subnet_ids" {
  description = "Public subnet IDs (ALB, NAT gateways)."
  value       = module.vpc.public_subnets
}

output "private_subnet_ids" {
  description = "Private subnet IDs with NAT egress (Fargate tasks)."
  value       = module.vpc.private_subnets
}

output "database_subnet_ids" {
  description = "Isolated database subnet IDs (no internet route)."
  value       = module.vpc.database_subnets
}

output "database_subnet_group_name" {
  description = "RDS DB subnet group name built from the database subnets."
  value       = module.vpc.database_subnet_group_name
}

output "nat_public_ips" {
  description = "Elastic IPs of the NAT gateways; give these to partner institutions that allow-list webhook source IPs."
  value       = module.vpc.nat_public_ips
}

output "lagos_local_zone_subnet_id" {
  description = "Subnet ID in the Lagos Local Zone, or null when enable_lagos_local_zone = false."
  value       = try(aws_subnet.lagos_local_zone[0].id, null)
}
