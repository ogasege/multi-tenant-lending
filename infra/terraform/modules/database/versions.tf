terraform {
  required_version = ">= 1.11"

  # Provider floors: secret_string_wo with an in-place switch from
  # secret_string (aws 6.50); ephemeral random_password (random 3.7).
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.50"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7"
    }
  }
}
