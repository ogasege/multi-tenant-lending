terraform {
  required_version = ">= 1.11"

  # Provider floors: the strictest child module (cache: aws 6.62,
  # security: random 3.9).
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.62"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.9"
    }
  }
}
