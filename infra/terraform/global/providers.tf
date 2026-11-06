# The primary directory table lives in aws_region; replicas and their
# CMKs are created in the other cell regions with the provider 6
# per-resource `region` argument. Route 53 is a global service.
provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = {
      Project            = "lending-core"
      Environment        = var.environment
      Owner              = var.owner
      CostCenter         = var.cost_center
      DataClassification = "internal" # routing metadata only, no PII
      ManagedBy          = "terraform"
    }
  }
}
