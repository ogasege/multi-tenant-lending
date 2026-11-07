terraform {
  # >= 1.11: one Terraform floor for every stack (cells need write-only
  # arguments, 1.11). Also covers the S3 backend's native lock file
  # (use_lockfile, GA in 1.10), which lets us drop the DynamoDB lock table.
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
