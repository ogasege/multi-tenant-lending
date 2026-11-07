terraform {
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Deliberately LOCAL state: this configuration creates the bucket that
  # every other state lives in (chicken-and-egg). It changes rarely, is
  # applied by a human admin, and its terraform.tfstate is kept out of
  # git (see README for the optional `terraform init -migrate-state`).
}
