terraform {
  # >= 1.10: the S3 backend's native lock file (use_lockfile) went GA in
  # 1.10, which is what lets us drop the DynamoDB lock table.
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}
