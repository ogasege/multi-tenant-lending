terraform {
  required_version = ">= 1.11"

  # Provider floors: secret_string_wo with an in-place switch from
  # secret_string (aws 6.50); ephemeral random_bytes (random 3.9).
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.50"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.9"
    }
  }
}
