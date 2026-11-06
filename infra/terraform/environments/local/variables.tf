variable "aws_region" {
  description = "Region LocalStack resources are created in; must match AWS_DEFAULT_REGION / AWS_REGION in docker-compose and the test setup."
  type        = string
  default     = "af-south-1"
}

variable "name" {
  description = "Name prefix; resource names must match the app's local .env (SQS_DOMAIN_EVENTS_QUEUE_URL, S3_BRANDING_BUCKET)."
  type        = string
  default     = "lending-local"
}

variable "cors_origins" {
  description = "Local front-end origins allowed to PUT presigned uploads."
  type        = list(string)
  default     = ["http://localhost:3000", "http://localhost:5173"]
}
