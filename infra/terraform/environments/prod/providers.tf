provider "aws" {
  region = var.aws_region

  # Guard-rail: refuse to run against any account but this env's, so a
  # stale AWS_PROFILE can never apply prod config to the dev account.
  allowed_account_ids = [var.aws_account_id]

  # Applied to every taggable resource: cost allocation (CostCenter),
  # ownership for incident routing, and DataClassification for
  # security reviews and AWS Config rules.
  default_tags {
    tags = {
      Project            = "lending-core"
      Environment        = var.environment
      Owner              = var.owner
      CostCenter         = var.cost_center
      DataClassification = "confidential"
      ManagedBy          = "terraform"
    }
  }
}
