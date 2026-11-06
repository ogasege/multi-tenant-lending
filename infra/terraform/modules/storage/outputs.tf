output "bucket_name" {
  description = "Name of the branding bucket (S3_BRANDING_BUCKET)."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "ARN of the branding bucket."
  value       = aws_s3_bucket.this.arn
}

output "tenant_objects_arn" {
  description = "ARN pattern covering every tenant object (<bucket>/tenants/*) for IAM policies."
  value       = "${aws_s3_bucket.this.arn}/${var.tenant_prefix}*"
}
