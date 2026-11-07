terraform {
  # >= 1.11: write-only arguments (*_wo) + ephemeral resources keep
  # generated secrets out of plan and state (1.11). Also covers the S3
  # backend's native lock file (use_lockfile, GA in 1.10), which is what
  # lets us drop the DynamoDB lock table.
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.62"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}
