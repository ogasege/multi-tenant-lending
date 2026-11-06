# Run with `tflocal` (terraform-local), which generates an override file
# pointing every AWS service endpoint at LocalStack (AWS_ENDPOINT_URL,
# default http://localhost:4566). The credentials below are LocalStack's
# conventional dummy values, not secrets.
provider "aws" {
  region = var.aws_region

  access_key = "test"
  secret_key = "test"

  # No real AWS account behind LocalStack.
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  s3_use_path_style           = true

  default_tags {
    tags = {
      Project     = "lending-core"
      Environment = "local"
      ManagedBy   = "terraform"
    }
  }
}
