provider "aws" {
  region = var.aws_region

  # No Environment tag here on purpose: apply roles deny any resource
  # whose Environment tag is not their own, and these shared resources
  # (state bucket, key, CI roles, boundaries) must stay usable by all.
  default_tags {
    tags = {
      Project            = "lending-core"
      Owner              = var.owner
      CostCenter         = "lending-core"
      DataClassification = "confidential"
      ManagedBy          = "terraform"
    }
  }
}
