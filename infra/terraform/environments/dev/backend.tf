# Partial configuration: the bucket name contains the account ID, so it
# is supplied at init time instead of being hard-coded:
#   terraform init -backend-config="bucket=<state bucket from bootstrap>"
# One state file per environment (separate key) = separate blast radius.
terraform {
  backend "s3" {
    key    = "lending/dev/terraform.tfstate"
    region = "af-south-1"
    # SSE on every write; the bucket's default SSE-KMS CMK applies.
    encrypt = true
    # S3-native locking (conditional writes on <key>.tflock). Replaces
    # the DynamoDB lock table: one fewer resource, IAM path and bill.
    use_lockfile = true
  }
}
