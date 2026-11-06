# bootstrap

This stack is applied **once per AWS account** by an administrator, using **local state**. It creates the bucket
that every other state lives in, so it cannot keep its own state there before the bucket exists. Keep
`terraform.tfstate` somewhere safe (it is git-ignored), or migrate it into the bucket afterwards under
`lending/bootstrap/`.

It creates:

* **State bucket** `<project>-tfstate-<account>`: versioned, SSE-KMS with a dedicated CMK and bucket key, Block
  Public Access, BucketOwnerEnforced, TLS-only, DeleteBucket denied, noncurrent versions expired after 90 days,
  and `prevent_destroy`. Locking uses S3-native `use_lockfile` (no DynamoDB).
* **GitHub OIDC provider**, plus:
  * `github-<project>-plan`, trusted for `repo:<repo>:pull_request` only. It can read **non-prod** state and
    decrypt it, and nothing else (prod state is explicitly denied). It has no secret values and no lock writes.
    PR plans run `-refresh=false -lock=false`.
  * `github-<project>-apply-<env>`, trusted for `repo:<repo>:environment:<env>` only (GitHub Environments; prod
    has required reviewers). Its four customer-managed policies are IAM (boundary-enforced) and state, read,
    compute (EC2 ABAC on the `Environment` tag) and data. Each is scoped to its own state key, its own names and
    secrets, and the allowed regions.
* **Per-environment permission boundaries** `<project>-boundary-<env>`. Every role an apply role creates must
  carry its environment's boundary, so workload roles can reach only that environment's queues, objects, secrets,
  keys and logs.

The production recommendation is one AWS account per environment (AWS Organizations and SCPs). Then run this
stack in each account with `environments = ["<env>"]`.

```bash
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform plan && terraform apply
```
