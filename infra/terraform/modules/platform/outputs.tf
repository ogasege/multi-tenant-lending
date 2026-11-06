output "name" {
  description = "Resource name prefix for this environment."
  value       = local.name
}

output "alb_dns_name" {
  description = "ALB DNS name; create the API hostname alias record pointing here."
  value       = module.alb.dns_name
}

output "alb_zone_id" {
  description = "ALB hosted zone ID for Route 53 alias records."
  value       = module.alb.zone_id
}

output "ecr_repository_url" {
  description = "ECR repository to push the lending-core image to."
  value       = module.ecr.repository_url
}

output "migrations_ecr_repository_url" {
  description = "ECR repository for the Flyway migrations image (built from db/Dockerfile)."
  value       = module.ecr_migrations.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.ecs.cluster_name
}

output "migrate_task_definition_arn" {
  description = "Task definition for the one-off migrations task (run with aws ecs run-task before each deploy)."
  value       = module.ecs.task_definition_arns["migrate"]
}

output "migrate_network_configuration" {
  description = "awsvpcConfiguration to pass to aws ecs run-task for the migrations task."
  value = {
    subnets        = module.network.private_subnet_ids
    securityGroups = [module.ecs.security_group_ids["migrate"]]
    assignPublicIp = "DISABLED"
  }
}

output "database_address" {
  description = "RDS endpoint hostname."
  value       = module.database.address
}

output "sqs_domain_events_queue_url" {
  description = "Domain-events queue URL."
  value       = module.messaging.queue_url
}

output "s3_branding_bucket" {
  description = "Branding bucket name."
  value       = module.storage.bucket_name
}

output "alarm_topic_arn" {
  description = "SNS topic receiving all alarms."
  value       = module.observability.alarm_topic_arn
}

output "nat_public_ips" {
  description = "Static egress IPs (webhook source IPs for partner allow-lists)."
  value       = module.network.nat_public_ips
}
