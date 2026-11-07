# bootstrap

This stack is applied **once per AWS account** by an administrator, using **local state**. It creates the bucket
that every other state lives in, so it cannot keep its own state there before the bucket exists. Keep
`terraform.tfstate` somewhere safe (it is git-ignored), or migrate it into the bucket afterwards under
`lending/bootstrap/`.

It creates:

- **State bucket** `<project>-tfstate-<account>`: versioned, SSE-KMS with a dedicated CMK and bucket key, Block
  Public Access, BucketOwnerEnforced, TLS-only, DeleteBucket denied, noncurrent versions expired after 90 days,
  and `prevent_destroy`. Locking uses S3-native `use_lockfile` (no DynamoDB).
- **GitHub OIDC provider**, plus (all trust policies match the **customised OIDC subject**, see below):
  - `github-<project>-plan`, trusted only for jobs bound to the **`plan` GitHub Environment** (required reviewers)
    in `infra.yml` on a PR merge ref:
    `repo:<repo>:environment:plan:ref:refs/pull/*/merge:job_workflow_ref:<repo>/.github/workflows/infra.yml@refs/pull/*/merge`.
    It can read **non-prod** state and decrypt it, and nothing else (prod state is explicitly denied). It has no
    secret values and no lock writes; plans run `-refresh=false -lock=false`. Unreviewed PR jobs (fmt, validate,
    test, tflint, checkov) run with **no backend and no AWS credentials**, so a malicious PR cannot reach state.
  - `github-<project>-apply-<env>`, trusted for exactly
    `repo:<repo>:environment:<env>:ref:refs/heads/main:job_workflow_ref:<repo>/.github/workflows/infra.yml@refs/heads/main`:
    the GitHub Environment, the `main` branch and the deploy workflow as it exists on `main`. A PR, another branch
    or another workflow that declares `environment: prod` gets no credentials. Its five customer-managed policies
    are IAM (boundary-enforced) and state, read, compute (EC2 ABAC on the `Environment` tag), data and DNS. Each is
    scoped to its own state key, its own names and secrets, and the allowed regions.
  - Route 53 **health checks** are managed by the **prod** apply role only. Route 53 has no tag-based
    authorisation and health-check IDs are random, so neither ABAC nor name scoping can confine them to an
    environment; non-prod roles have no health-check Allow and an explicit Deny, and the `global` stack creates
    health checks for the prod tier only (non-prod geolocation records rely on ALB `evaluate_target_health`).
- **Per-environment permission boundaries** `<project>-boundary-<env>`. Every role an apply role creates must
  carry its environment's boundary, so workload roles can reach only that environment's queues, objects, secrets,
  keys and logs.

The production recommendation, and the hard boundary, is **one AWS account per environment** (AWS Organizations and
SCPs). Then run this stack in each account with `environments = ["<env>"]`; everything above (ABAC, name scoping,
the prod-only health-check rule) becomes defence in depth.

## GitHub configuration (required before the CI roles work)

1. **OIDC subject template** (repository level). The trust policies match `sub` only, because IAM evaluates `sub`
   and `aud` for every OIDC provider; embedding `ref` and `job_workflow_ref` in `sub` means the branch and workflow
   binding does not depend on which other GitHub claims IAM exposes as condition keys. Set it before (or together
   with) applying this stack; until then every CI role assumption fails closed:
   ```bash
   gh api --method PUT repos/<owner>/<repo>/actions/oidc/customization/sub \
     -F use_default=false \
     -f 'include_claim_keys[]=repo' -f 'include_claim_keys[]=context' \
     -f 'include_claim_keys[]=ref' -f 'include_claim_keys[]=job_workflow_ref'
   gh api repos/<owner>/<repo>/actions/oidc/customization/sub   # verify
   ```
   The `github_oidc_subject_template` and `github_oidc_subjects` outputs show exactly what the roles expect.
2. **Environments**
   - `plan`: required reviewers (enable "Prevent self-review"). Approving it releases a plan of the PR's code with
     non-prod state access, so review the diff (workflow, providers, data sources) first. No branch restriction
     (PR jobs run on `refs/pull/<n>/merge`).
   - `dev`, `staging`, `prod`: **deployment branches = selected branches, `main` only** (and no tag rules).
     `prod` additionally has required reviewers with "Prevent self-review", and admins should not bypass.
     Each carries `AWS_APPLY_ROLE_ARN`, `TFVARS`, `IMAGE_REFERENCE`, `MIGRATIONS_IMAGE_REFERENCE`.
3. **Branch protection on `main`** (required reviews, required status checks), since the apply roles trust
   whatever `infra.yml` says on `main`.
4. Repository variables: `AWS_PLAN_ROLE_ARN` (repo level so the job-level `if` can see it), `TF_STATE_BUCKET`,
   `TFVARS_DEV`, `TFVARS_STAGING`, `INFRA_APPLY_ENABLED=true`.

```bash
cp terraform.tfvars.example terraform.tfvars
terraform init && terraform plan && terraform apply
```
