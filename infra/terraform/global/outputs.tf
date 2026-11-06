output "directory_table_name" {
  description = "DIRECTORY_TABLE_NAME for every cell of this tier."
  value       = module.directory.table_name
}

output "directory_regional_table_arns" {
  description = "Region => table/replica ARN; each cell's tasks get only their own region's ARN."
  value       = module.directory.regional_table_arns
}

output "directory_regional_kms_key_arns" {
  description = "Region => CMK of that region's directory copy."
  value       = module.directory.regional_kms_key_arns
}

output "cell_hostnames" {
  description = "Region => stable cell hostname (CELL_API_BASE_URL host)."
  value       = try(module.edge[0].cell_hostnames, {})
}
