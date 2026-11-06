# Partial configuration. One global stack per environment tier, stored
# INSIDE that tier's state prefix so only that tier's apply role can
# write it:
#   terraform init \
#     -backend-config="bucket=<state bucket>" \
#     -backend-config="key=lending/<env>/global/terraform.tfstate"
terraform {
  backend "s3" {
    region       = "af-south-1"
    encrypt      = true
    use_lockfile = true
  }
}
