# directory

This module is the global control plane's **tenant directory**: a DynamoDB global table keyed by `slug` that maps
each institution to its home cell.

* The primary table lives in the provider region. Every other entry in `cell_regions` gets a **replica**. It is
  multi-active, and each cell reads its local replica.
* Encryption uses a **CMK per region**: the replica keys are created in their own regions through the AWS
  provider 6 `region` argument.
* Point-in-time recovery on the table and on every replica, deletion protection, and `PAY_PER_REQUEST` billing.
* The table holds **routing metadata only**: slug, home region, status and cell URL. It has no PII and no
  financial data.
* Output `regional_table_arns` and `regional_kms_key_arns` let each cell grant its tasks access to **its own
  region's** replica and key only.

LocalStack: use `cell_regions = [<local region>]` for a single-region table (no replicas).

Tests: `terraform test` (`tests/directory.tftest.hcl`).
