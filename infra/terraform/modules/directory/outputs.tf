output "table_name" {
  description = "Tenant directory table name (DIRECTORY_TABLE_NAME)."
  value       = aws_dynamodb_table.this.name
}

output "table_arn" {
  description = "ARN of the table in the primary region."
  value       = aws_dynamodb_table.this.arn
}

output "regional_table_arns" {
  description = "Map of region to the table/replica ARN in that region (grant tasks access to their own region's ARN only)."
  value = merge(
    { (local.primary_region) = aws_dynamodb_table.this.arn },
    { for r in aws_dynamodb_table.this.replica : r.region_name => r.arn },
  )
}

output "regional_kms_key_arns" {
  description = "Map of region to the CMK encrypting that region's copy of the table."
  value = merge(
    { (local.primary_region) = aws_kms_key.primary.arn },
    { for r, k in aws_kms_key.replica : r => k.arn },
  )
}
