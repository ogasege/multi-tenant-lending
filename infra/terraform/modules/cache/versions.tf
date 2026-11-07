terraform {
  required_version = ">= 1.11"

  # Provider floors: auth_token_wo on the replication group (aws 6.62);
  # ephemeral random_password (random 3.7).
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.62"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7"
    }
  }
}
