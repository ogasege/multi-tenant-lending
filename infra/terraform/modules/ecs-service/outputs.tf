output "cluster_name" {
  description = "ECS cluster name (CloudWatch ClusterName dimension)."
  value       = aws_ecs_cluster.this.name
}

output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_names" {
  description = "Map of workload key to ECS service name (services only)."
  value       = { for k, s in aws_ecs_service.this : k => s.name }
}

output "task_definition_arns" {
  description = "Map of workload key to task definition ARN (use the migrate one with `aws ecs run-task`)."
  value       = { for k, t in aws_ecs_task_definition.this : k => t.arn }
}

output "security_group_ids" {
  description = "Map of workload key to task security group ID (allow-list these on RDS/Valkey)."
  value       = { for k, sg in aws_security_group.task : k => sg.id }
}

output "task_role_arns" {
  description = "Map of workload key to task role ARN."
  value       = { for k, r in aws_iam_role.task : k => r.arn }
}

output "execution_role_arns" {
  description = "Map of workload key to execution role ARN."
  value       = { for k, r in aws_iam_role.execution : k => r.arn }
}
