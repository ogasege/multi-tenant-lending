output "alb_dns_name" {
  description = "ALB DNS name; point the API hostname alias record here."
  value       = module.platform.alb_dns_name
}

output "ecr_repository_url" {
  description = "ECR repository to push the lending-core image to."
  value       = module.platform.ecr_repository_url
}

output "migrations_ecr_repository_url" {
  description = "ECR repository for the Flyway migrations image."
  value       = module.platform.migrations_ecr_repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name."
  value       = module.platform.ecs_cluster_name
}

output "migrate_task_definition_arn" {
  description = "One-off migrations task definition (run before each deploy)."
  value       = module.platform.migrate_task_definition_arn
}

output "migrate_network_configuration" {
  description = "awsvpcConfiguration for aws ecs run-task (migrations)."
  value       = module.platform.migrate_network_configuration
}

output "alarm_topic_arn" {
  description = "SNS topic receiving all alarms."
  value       = module.platform.alarm_topic_arn
}

output "nat_public_ips" {
  description = "Static egress IPs (webhook source IPs)."
  value       = module.platform.nat_public_ips
}
