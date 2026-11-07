# Lending Core: Terraform

This is the AWS infrastructure for the multi-tenant lending backend (`docs/design/SPEC.md`). On ECS Fargate, one
app image runs as two processes (the API and the worker), and a one-off Flyway migrations task runs from its own
image (`db/Dockerfile`). They sit behind an ALB
with WAF and use RDS PostgreSQL 16, ElastiCache Valkey, SQS (with a DLQ) and S3. Everything is encrypted with
customer-managed KMS keys.

```
infra/terraform/
├── .terraform-version          1.11.4 (tfenv / CI; write-only secrets need ≥ 1.11)
├── .tflint.hcl                 terraform + aws rulesets, recommended preset
├── .checkov.yaml               no global skips: every exception is inline with a reason
├── bootstrap/                  state bucket + KMS, GitHub OIDC, CI roles, per-env permission boundaries (local state)
├── global/                     global control plane per tier: tenant directory + Route 53 routing
├── modules/
│   ├── network/                VPC (terraform-aws-modules/vpc 6.7.3), 3 AZs, endpoints, flow logs, Lagos LZ option
│   ├── security/               KMS CMKs per data domain, WAFv2 web ACL + logging, app secrets
│   ├── database/               RDS PostgreSQL 16, force_ssl, PI, backups, DR backup replication, role secrets
│   ├── cache/                  ElastiCache Valkey, TLS required, AUTH token -> REDIS_URL secret
│   ├── messaging/              SQS domain-events + DLQ (5 receives), SSE-KMS, TLS-only, DLQ alarm   [tests]
│   ├── storage/                S3 branding bucket, tenants/ prefix guard, presigned-PUT CORS        [tests]
│   ├── ecr/                    immutable tags, scan on push, lifecycle, KMS (app + migrations repos)
│   ├── ecs-service/            cluster, per-workload task defs/roles/SGs, services, autoscaling      [tests]
│   ├── alb/                    HTTPS (TLS 1.3 policy), HTTP->HTTPS, access logs, WAF association
│   ├── observability/          log groups, per-tenant error metric, SNS topic, alarms
│   ├── directory/              DynamoDB global table (slug → home cell), CMK per region, PITR      [tests]
│   ├── edge/                   Route 53 per-cell records, geolocation entry point, health checks
│   └── platform/               composition of all modules = one environment (one cell)               [tests]
└── environments/
    ├── dev/  staging/  prod/   thin roots: backend, providers, sizing -> module "platform"
    └── local/                  LocalStack target (S3, SQS+DLQ, KMS, Secrets Manager) for tests/compose
```

## Architecture

```
 Internet ──► WAF (managed rules, per-IP + /auth rate limits)
                 │
            ALB (public subnets, TLS 1.3 policy, :80 → 301)
                 │ :3000 (SG → SG)
   ┌─────────────┴──────────── private subnets (3 AZs, NAT egress) ──────────────┐
   │  ECS Fargate  api (CMD dist/main.js)     worker (CMD dist/worker.js)        │
   │               migrate (one-off Flyway task, own image from db/Dockerfile)    │
   └──────┬──────────────┬───────────────┬───────────────┬───────────────────────┘
          │5432          │6379 (TLS)     │HTTPS           │HTTPS (gateway endpoint)
   RDS PostgreSQL 16   Valkey          SQS domain-events  S3 branding (tenants/{id}/…)
   (isolated subnets,  (isolated        └► DLQ (5 receives) → alarm → SNS
    Multi-AZ, KMS)      subnets, KMS)
          └─ automated backups (snapshots + WAL) replicated → dr_region (KMS key there)
```

### Runtime contract (SPEC §12) → where each value comes from

| Variable                                                                                                                       | Source                                                                                                                                                                          | api | worker | migrate |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-: | :----: | :-----: |
| `NODE_ENV`, `PORT`, `LOG_LEVEL`, `AWS_REGION`, `CELL_REGION`, `CORS_ORIGINS`, `JWT_ISSUER`                                     | plain env (platform module)                                                                                                                                                     |  ✔  |   ✔    |    ✔    |
| `DATABASE_HOST/PORT/NAME`, `DATABASE_SSL=true`                                                                                 | plain env from `module.database`                                                                                                                                                |  ✔  |   ✔    |    ✔    |
| `SQS_DOMAIN_EVENTS_QUEUE_URL`, `S3_BRANDING_BUCKET`                                                                            | plain env                                                                                                                                                                       |  ✔  |   ✔    |    ✔    |
| `DATABASE_APP_USER` / `DATABASE_APP_PASSWORD`                                                                                  | env / secret `<name>/db/lending_app:password`                                                                                                                                   |  ✔  |   ✔    |    ✔    |
| `DATABASE_WORKER_USER` / `DATABASE_WORKER_PASSWORD`                                                                            | env / secret `<name>/db/lending_worker:password`                                                                                                                                |     |   ✔    |    ✔    |
| `DATABASE_MIGRATOR_USER` / `DATABASE_MIGRATOR_PASSWORD`                                                                        | RDS-managed master secret `username` / `password`                                                                                                                               |     |        |    ✔    |
| `REDIS_URL` (`rediss://:token@host:6379`)                                                                                      | secret `<name>/redis:url`                                                                                                                                                       |  ✔  |   ✔    |         |
| `JWT_SECRET`, `BVN_HMAC_KEY`, `DATA_ENCRYPTION_KEY`                                                                            | secret `<name>/app` (JSON keys)                                                                                                                                                 |  ✔  |   ✔    |         |
| `CELL_API_BASE_URL` (`https://<region>.api.<domain>`), `DIRECTORY_TABLE_NAME`                                                  | plain env (global control plane)                                                                                                                                                |  ✔  |   ✔    |    ✔    |
| `CELL_ORIGIN_SUFFIX` (`.api.<domain>`), optional `CELL_ORIGINS` (JSON region → origin)                                         | plain env; required by the app in production (redirect allow-list)                                                                                                              |  ✔  |   ✔    |    ✔    |
| `RATE_LIMIT_TENANT_STAFF_PER_MINUTE` (3000), `RATE_LIMIT_TENANT_CUSTOMER_PER_MINUTE` (1500), `SIGNUP_RATE_LIMIT_PER_HOUR` (30) | plain env (`rate_limits` variable)                                                                                                                                              |  ✔  |   ✔    |    ✔    |
| `KYC_PROVIDER`                                                                                                                 | plain env, **API only**: `mock` in dev/staging; prod variable has **no default**                                                                                                |  ✔  |        |         |
| `PAYMENT_PROVIDER`, `CREDIT_BUREAU_PROVIDER`, `CHECKOUT_ORDERS_PROVIDER`                                                       | plain env, **API only** (`payment_provider`, `credit_bureau_provider`, `checkout_orders_provider`): `mock` in dev/staging; prod variables have **no default** and reject `mock` |  ✔  |        |         |
| `REPAYMENT_MAX_BACKDATE_DAYS`                                                                                                  | plain env, **API only** (`repayment_max_backdate_days`, integer 0–31, default 3)                                                                                                |  ✔  |        |         |
| `EOD_RUN_AT_LOCAL_TIME`                                                                                                        | not set by Terraform: the worker uses the app default `00:05` (see note below)                                                                                                  |     |   ✔    |         |
| `AWS_ENDPOINT_URL`                                                                                                             | **never set in AWS** (rejected by `ecs-service` validation); only for LocalStack                                                                                                |     |        |         |

`DATABASE_SSL=true` is enforced by validation, as is the absence of `AWS_ENDPOINT_URL`. `REDIS_URL` is always
`rediss://` (TLS required on Valkey).

> **Before go-live:** the app **refuses `KYC_PROVIDER=mock` in production**. `environments/prod` therefore has a
> `kyc_provider` variable with no default, and the platform validation also rejects `mock` for prod. A real KYC
> provider (and its credentials) must be configured before the first prod deploy.
>
> The same applies to `PAYMENT_PROVIDER`, `CREDIT_BUREAU_PROVIDER` and `CHECKOUT_ORDERS_PROVIDER`: only `mock` exists
> today and **production refuses mocks**, so real payment, credit-bureau and checkout-order providers (and their
> credentials) must be configured before go-live. The prod variables have no default, reject `mock`, and the
> `terraform.tfvars.example` placeholders fail validation so the example cannot be applied by accident.

> **`EOD_RUN_AT_LOCAL_TIME` semantics changed:** it now means "close the **previous** local date at this time" (in
> each lender's time zone), not "close today at this time". Keep it just after midnight (default `00:05`). If it is
> ever overridden in a task definition, do not set it to an end-of-business time such as `23:30`: that would delay
> closing each business date by almost a full day.

ECS injects secrets at task start through `secrets[].valueFrom = "<arn>:<json-key>::"`. Values never show up in
the task definition, the console or a plan.

### Database credentials: least-privilege split

- **api**: its execution role can read only the `lending_app` secret. `lending_app` is `NOBYPASSRLS`, so every
  tenant request is fenced by RLS.
- **worker**: reads the `lending_worker` secret and the `lending_app` secret. `lending_worker` is also
  `NOBYPASSRLS`: the outbox relay and EOD jobs reach across tenants only through an explicit `worker_all` RLS
  policy, which keeps that access auditable. Tenant-scoped reads use `lending_app`, so normal RLS applies to them.
  The worker can never read the RDS master secret.
- **migrate** is the only principal allowed to read the **RDS-managed master secret** (`manage_master_user_password`,
  rotated by RDS, encrypted with the `secrets` CMK). Flyway runs DDL as the schema owner. It also reads both role
  passwords because the Flyway callback `db/callbacks/beforeMigrate.sql` creates or `ALTER`s the `lending_app`
  and `lending_worker` login roles with the passwords Terraform generated. The image bundles the RDS CA for
  `sslmode=verify-full` (`DATABASE_SSL_ROOT_CERT` can override it).
- **Worker runtime:** `stopTimeout` is 120 s (≥ 60 s) for graceful drain. There is no HTTP health check,
  because the worker serves no HTTP; the container is `essential`, so ECS replaces the task if the process exits.
  The task role can `SendMessage`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` and
  `GetQueueAttributes` on the domain-events queue, with KMS on its key. It has DynamoDB write access to this
  cell's directory replica only. The SQS visibility timeout is 60 s. Security-group egress allows 443 to any
  destination for webhook delivery to lender endpoints; **SSRF protection is in the app** (HTTPS only, plus a
  resolved-IP check that rejects private, link-local and metadata ranges such as 169.254.169.254).
- Each workload has its own execution role. The IAM statement lists only the secret ARNs that workload injects, and
  `modules/ecs-service/tests` asserts that the API role cannot read the master secret.
- Terraform never connects to Postgres: no `postgresql` provider and no network path from CI into the VPC.

> **Open question for the app team:** SPEC §4 says the platform module (served by the **API**) uses
> `lending_worker` to register institutions. The split above, as specified, gives the API only `lending_app`.
> Either institution registration moves behind the worker or a SECURITY DEFINER function, or the API gets the
> worker secret too. Decide this before go-live.

## Environments

|                       | dev                               | staging                                                                                      | prod                         | local                                                                              |
| --------------------- | --------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| Purpose               | cheap integration                 | prod-shaped rehearsal: migrations, partner UAT/sandbox (webhooks, branding), RC verification | production                   | LocalStack test target for integration tests and docker-compose (not a deployment) |
| NAT                   | 1 shared                          | 1 per AZ                                                                                     | 1 per AZ                     | n/a                                                                                |
| Interface endpoints   | off                               | on                                                                                           | on                           | n/a                                                                                |
| RDS                   | db.t4g.micro, single-AZ, 3 d PITR | db.t4g.medium, Multi-AZ, 7 d                                                                 | db.m6g.large, Multi-AZ, 35 d | n/a                                                                                |
| DR backup replication | off                               | on (synthetic data, used for restore drills)                                                 | on (encrypted, to London)    | n/a                                                                                |
| Valkey                | 1 × t4g.micro                     | 2 × t4g.small, failover                                                                      | 2 × m6g.large, failover      | n/a                                                                                |
| API tasks (min/max)   | 1/2                               | 2/4                                                                                          | 2/10                         | n/a                                                                                |
| Deletion protection   | off                               | on                                                                                           | on                           | n/a                                                                                |
| State key             | `lending/dev/terraform.tfstate`   | `lending/staging/…`                                                                          | `lending/prod/…`             | local file                                                                         |

Sizes live in each `environments/<env>/main.tf` as reviewed code. Only identifiers and account-specific values go in
`terraform.tfvars`.

## Usage

### 0. One-time account preparation

1. Enable the opt-in region: `aws account enable-region --region-name af-south-1` (poll
   `aws account get-region-opt-status` until it reports `ENABLED`).
2. Issue an ACM certificate for the API hostname **in af-south-1**, using DNS validation.

### 1. Bootstrap (admin credentials, local state)

```bash
cd infra/terraform/bootstrap
cp terraform.tfvars.example terraform.tfvars   # set github_repository
terraform init && terraform apply
```

The outputs give you the state bucket, the plan role, a map of per-env apply roles and per-env permission
boundaries. The state stays **local** on purpose, because this stack creates the bucket every other state lives in.
It changes rarely and is applied by a human. Keep `terraform.tfstate` in a secure location (it is git-ignored), or
run `terraform init -migrate-state` afterwards with a `backend "s3"` block pointing at
`key = "lending/bootstrap/terraform.tfstate"`.

GitHub setup (details and the exact `gh api` call in [bootstrap/README.md](bootstrap/README.md#github-configuration-required-before-the-ci-roles-work)):

- **OIDC subject template** customised to `repo`, `context`, `ref`, `job_workflow_ref` (repository level). The CI
  roles match on it; until it is set, every role assumption fails closed.
- Repository variables: `AWS_PLAN_ROLE_ARN`, `TF_STATE_BUCKET`, `TFVARS_DEV`, `TFVARS_STAGING`,
  `INFRA_APPLY_ENABLED=true`.
- Environment `plan` with required reviewers (PR plans wait for approval).
- Environments `dev`, `staging` and `prod`, each with deployment branches limited to **`main`** and variables
  `AWS_APPLY_ROLE_ARN`, `TFVARS`, `IMAGE_REFERENCE` and `MIGRATIONS_IMAGE_REFERENCE`. Give **prod** required
  reviewers (prevent self-review).

### 2. An environment

```bash
cd infra/terraform/environments/dev
cp terraform.tfvars.example terraform.tfvars
terraform init -backend-config="bucket=lending-tfstate-<account-id>"
# First time only: create the registry, then push the image (by digest).
terraform apply -target=module.platform.module.ecr
terraform apply
```

### 3. Release order (the CI `apply` job does this)

1. **Build and push the migrations image.** This is done by the app pipeline: `db/Dockerfile`, context `db/`,
   tagged with the git SHA and pushed to `<name>/lending-migrations`. Its digest becomes
   `MIGRATIONS_IMAGE_REFERENCE`. The app image works the same way and becomes `IMAGE_REFERENCE`.
2. **Register only the new migrate task definition and the DB role secrets** with
   `terraform apply -target='module.platform.module.ecs.aws_ecs_task_definition.this["migrate"]'
-target='module.platform.module.database.aws_secretsmanager_secret_version.role'`, then run it and wait for
   **exit code 0**. The role secrets are write-only, so they are written here, before the Flyway `beforeMigrate`
   callback sets the same passwords in Postgres:
   ```bash
   aws ecs run-task --cluster lending-<env> --launch-type FARGATE \
     --task-definition "$(terraform output -raw migrate_task_definition_arn)" \
     --network-configuration "{\"awsvpcConfiguration\": $(terraform output -json migrate_network_configuration)}"
   aws ecs wait tasks-stopped ...; aws ecs describe-tasks ... --query 'tasks[0].containers[0].exitCode'
   ```
3. **Only then run the full `plan` and `apply`**, which rolls the api and worker. New code never runs against an old
   schema, so migrations must stay backward compatible with the previous release (expand, then contract).

Promotion: CI builds each image once. The **same `sha256` digest** then moves dev → staging → prod, copied between
the per-env ECR repositories with `crane copy` / `docker buildx imagetools create`, which keeps the digest. Tags are
immutable, and prod's GitHub Environment needs an approval.

### Local (LocalStack)

```bash
docker run -d --rm --name localstack -p 4566:4566 localstack/localstack:4.14.0
pipx install terraform-local
cd infra/terraform/environments/local
tflocal init && tflocal apply -auto-approve
tflocal output    # SQS_DOMAIN_EVENTS_QUEUE_URL, S3_BRANDING_BUCKET for .env / test setup
```

`tflocal` writes a git-ignored `localstack_providers_override.tf` that points every AWS endpoint at
`AWS_ENDPOINT_URL` (default `http://localhost:4566`). This composition reuses the real `messaging` and `storage`
modules, so local behaviour matches the cloud: DLQ after 5 receives, SSE-KMS, the tenant-prefix policy and CORS.
The default region is `af-south-1`, matching the project's docker-compose `AWS_DEFAULT_REGION`. The LocalStack
container must enable **`SERVICES=s3,sqs,dynamodb,kms,secretsmanager`**. The compose file currently enables only
`s3,sqs,dynamodb`, so add `kms,secretsmanager` there. LocalStack Community does not enforce IAM or bucket policies, so test the policy logic with
`terraform test`.

### Quality gates (what CI runs)

Terraform **≥ 1.11** is required (write-only arguments). Without a local 1.11, use the pinned image, e.g.
`docker run --rm -v "$PWD:/tf" -w /tf/<dir> -e TF_DATA_DIR=/tmp/tfdata hashicorp/terraform:1.11.4@sha256:5820b87995595425074f881500a037b0ccd41158d0d9b44d78f5f120612f2d3d <command>`
(a container-local `TF_DATA_DIR` keeps host-OS providers in `.terraform/` untouched).

```bash
terraform fmt -recursive -check
for d in bootstrap global modules/* environments/*; do (cd $d && terraform init -backend=false && terraform validate); done
for d in bootstrap modules/messaging modules/storage modules/ecs-service modules/directory modules/security \
         modules/platform modules/database modules/cache modules/edge; do (cd $d && terraform test); done
docker run --rm -v "$PWD:/data" -w /data ghcr.io/terraform-linters/tflint:v0.65.0 --init
docker run --rm -v "$PWD:/data" -w /data ghcr.io/terraform-linters/tflint:v0.65.0 --recursive --config /data/.tflint.hcl
docker run --rm -v "$PWD:/tf" -w /tf bridgecrew/checkov:3.4.3@sha256:bfe9d70bb7f044aba49bd99675813445f106dee6072da583f51008cb667f3a63 --config-file .checkov.yaml
actionlint ../../.github/workflows/infra.yml
```

## Multi-region cells & global routing

Data residency uses a **cell-based architecture** (AWS SaaS Lens deployment stamps, SPEC §4.1). Region choice per
cell is covered in **ADR-001**.

```
                 ┌──────────── global control plane (global/, one per tier) ────────────┐
                 │  DynamoDB global table  lending-<env>-tenant-directory  (slug → cell)  │
                 │   primary af-south-1 ◄──replication──► eu-west-3 ◄──► eu-west-2        │
                 │  Route 53: api.<domain> geolocation  +  <region>.api.<domain> per cell │
                 └──────────────┬───────────────────────────┬─────────────────────────────┘
       cell af-south-1 (NG)     │      cell eu-west-3 (WAEMU) │      cell eu-west-2 (UK)
   VPC · RDS · Valkey · SQS · S3 · KMS · WAF · state   (nothing shared between cells)
```

- A **cell** is one complete deployment of the `platform` composition in one region. Each tenant is pinned to a home
  cell by its regulator profile: af-south-1 for Nigerian lenders (with the Lagos Local Zone path), eu-west-3 as the
  candidate for WAEMU lenders under Senegal's CDP, and eu-west-2 for UK lenders.
- **Cells share nothing.** Each has its own VPC, RDS, Valkey, SQS, S3, KMS keys, secrets, WAF, alarms and state
  file. The only cross-region data is the tenant directory, which holds **routing metadata only**: slug, home
  region, status and cell URL, with no PII and no financial data. DR backup copies are the other exception, and only
  where legally permitted.
- **Global control plane (built, `global/`):**
  - **Tenant directory** (`modules/directory`): a DynamoDB global table keyed by `slug`, on-demand, with a CMK
    **per region** (replica keys are created in their own regions), PITR and deletion protection on the table and
    every replica. There is one replica per `cell_regions` entry. Each cell's tasks get access to **their own
    region's replica ARN and key only**: the API gets `GetItem`, and the worker gets
    `GetItem/PutItem/UpdateItem/ConditionCheckItem` for registration. Writes replicate to the other regions.
  - **Edge** (`modules/edge`): `<region>.api.<domain>` is an alias to each cell's ALB. `api.<domain>` uses
    geolocation records (AF → af-south-1; EU and GB → eu-west-2; the WAEMU countries SN, CI, ML, BF, NE, TG, BJ
    and GW → eu-west-3; default → af-south-1). Each cell has a Route 53 HTTPS health check on `/health/ready`, so
    an unhealthy cell drops out and Route 53 falls back to the broader rule or the default.
  - There is one global stack **per environment tier**, with state at `lending/<env>/global/terraform.tfstate`
    and resources tagged `Environment=<env>`. _Deviation from a single `lending/global` key:_ putting it under the
    tier's prefix means that tier's apply role owns it under the same boundary and ABAC rules, and that dev cells
    can never read the prod directory.
- **Slug reservation and residual risk.** At registration the API reserves the slug with a conditional `PutItem`
  (`attribute_not_exists(slug)`), and uses `DeleteItem` to roll back if registration fails. Its task role has
  `GetItem/PutItem/DeleteItem` on **this cell's replica only**. `dynamodb:LeadingKeys` is not used, because the
  key is the arbitrary new slug, so there is no fixed key set to pin to.
  **Residual risk:** global-table conditional writes are only _regionally_ consistent. Two cells could each
  reserve the same slug within the replication lag (typically under a second), and last-writer-wins then
  silently picks one. Mitigations: (a) DynamoDB **multi-region strong consistency (MRSC)** global tables, which
  give a strongly consistent conditional write across regions, at the cost of higher write latency and a
  constrained region set (verify that af-south-1, eu-west-2 and eu-west-3 can form an MRSC set); or (b) a single
  designated **registration region** that performs every reservation, at the cost of cross-region latency on
  onboarding only. Until then, the app should re-read after replication (or the worker should reconcile) and
  flag conflicts.
- **Routing protocol** (implemented by the app; Terraform supplies `CELL_REGION`, `CELL_API_BASE_URL =
https://<region>.api.<domain>` and `DIRECTORY_TABLE_NAME`):
  - A public or slug-addressed request (for example `POST /v1/auth/login {institutionSlug}`) that lands on the
    wrong cell (geolocation is only a guess) is looked up in the local directory replica and answered with a
    **307 Temporary Redirect** to the home cell URL. 307 preserves the method and body, so the client simply
    replays the request there.
  - An authenticated request whose token's tenant belongs to another cell is answered with **421 Misdirected
    Request** plus the home cell URL. The cell never proxies, because proxying would move tenant payloads across
    regions. Clients cache the cell URL after login.
  - Registering an institution whose home region differs from `CELL_REGION` is rejected. The worker writes the
    directory entry with a conditional put (slug uniqueness across all cells).
- **Apply order:** the global stack first (directory only, `cells = {}`), then each cell (it needs
  `directory_table_name` and `directory_kms_key_arn` for its region), then the global stack again with `cells` set
  from each cell's ALB outputs. Each cell's ACM certificate must cover `api.<domain>` and `<region>.api.<domain>`.
- **Adding a cell**, for example prod in eu-west-3:
  1. Copy `environments/prod` to `environments/prod-euw3`. Set `aws_region = "eu-west-3"`, a suitable
     `dr_region`, `cell_id = "euw3"` on the `platform` module (global names become `lending-prod-euw3-*`) and a
     distinct `vpc_cidr`.
  2. Use the state key `lending/prod/euw3/terraform.tfstate`, which stays inside the prod apply role's
     `lending/prod/*` scope.
  3. Make sure the region is in bootstrap `cell_regions` (default `["eu-west-3"]`) and global `cell_regions`.
     Add the cell to global `cells`, and add the directory to the CI matrices.

## Region, opt-in and DR mechanics

The rationale and evidence are in **ADR-001 in `docs/TECHNICAL_DECISIONS.md`**. In short: the company is
Lagos-headquartered and Nigeria is the primary market. af-south-1 is the parent region of the Lagos Local Zone
(`af-south-1-los-1a`), which is the only AWS path to in-country data residency for the CBN payment-data
localisation circular (effective 1 Jan 2027). It also has the lowest measured latency from Lagos. The trade-offs
are that it is an opt-in region with roughly a 19% RDS and 35% Fargate premium over eu-west-1, and RDS does not
offer `db.m7g` there, so staging and prod use `t4g`/`m6g`.

This section covers only the mechanics:

- `aws_region` (default `af-south-1`) and `dr_region` (default `eu-west-2`) are validated variables, and
  `dr_region` must differ from `aws_region`.
- **Opt-in region:** enable it on the account before running anything (step 0). The AWS provider uses
  **regional** STS endpoints, so tokens are valid in opt-in regions. `allowed_account_ids` stops a run against the
  wrong account.
- **DR:** `aws_db_instance_automated_backups_replication` copies snapshots **and transaction logs** to `dr_region`,
  so PITR is possible there (RPO in minutes). The backups are re-encrypted with a CMK created **in `dr_region`**,
  because KMS keys are regional. Both use the AWS provider 6 per-resource `region` argument instead of aliased
  providers.
  **Data residency:** the CBN localisation circular requires Nigerian payment-transaction data to stay in
  Nigeria. When it applies to a lender, set `enable_dr_backup_replication = false` in prod and use the
  in-country Lagos Local Zone path below for recovery instead.
- **Lagos Local Zone:** `enable_lagos_local_zone` (network module, default `false`) adds an isolated private subnet
  in `af-south-1-los-1a`, with its own route table and no default route. The zone group must be opted in first.
  The Local Zone offers **only EC2, EBS gp2 and ALB**: no RDS and no Fargate. An in-country data cell would
  therefore be self-managed PostgreSQL on EC2 in that subnet. This is the documented residency path; only the
  network foothold is built.

## Decisions

Each entry gives the decision, the alternatives considered, the rationale and the trade-off or cost.

1. **Primary region af-south-1, DR region eu-west-2.** See ADR-001.
   _Mechanics:_ see above. _Cost:_ opt-in region premium (about 19% RDS, about 35% Fargate vs eu-west-1), plus DR
   storage and cross-region transfer for the replicated backups.

2. **DR = RDS automated backup replication to `dr_region`.**
   _Alternatives:_ a cross-region read replica, which gives lower RTO but doubles instance cost and is a running
   offshore copy; scheduled snapshot copy (Lambda or AWS Backup copy jobs), which gives daily RPO; AWS Backup with
   a vault in the DR region.
   _Rationale:_ point-in-time restore in the DR region with no extra compute, at an RPO of minutes. It is a single
   resource and needs no scheduler.
   _Trade-off:_ RTO is hours (restore the instance, re-deploy the stack in the DR region). ElastiCache and S3 are
   not replicated: the cache can be rebuilt, and tenants can re-upload branding. Under CBN localisation the
   offshore copy is switched off and recovery stays in the Lagos Local Zone.

3. **Compute = ECS Fargate.**
   _Alternatives:_ EKS (control-plane fee of about $73/month per cluster, plus upgrades, add-ons and a Kubernetes
   skill requirement); App Runner (no worker or one-off task model, limited VPC and WAF control; af-south-1 availability unconfirmed); Lambda (poor fit for a long-polling SQS worker with 120 s graceful drain and for connection-pooled
   Postgres without RDS Proxy; cold starts on the API).
   _Rationale:_ no servers or cluster to patch, native IAM per task, secrets injection, ALB integration, and a
   deployment circuit breaker. One app image runs as two services, plus the Flyway task.
   _Trade-off:_ Fargate costs more per vCPU than EC2-backed ECS (and carries the af-south-1 premium). There is no
   DaemonSet-style sidecar management. ECS Exec is disabled, so debugging goes through logs or a one-off task.

4. **One app image for api and worker; migrations as a one-off Flyway task with its own image and ECR repository.**
   _Alternatives:_ run migrations at API boot (races between tasks, and the API would need DDL rights); an init
   container (same rights problem); a CI runner connecting to RDS (needs a network path in).
   _Rationale:_ migrations run once per release, before services roll, with the only principal that can read the
   master secret, pulled from a separate repository the api and worker roles cannot read. Exit code 0 gates the
   deploy. Flyway (JVM) gets 512 vCPU units and 1 GiB.
   _Trade-off:_ the release pipeline must run `run-task` and wait, which is an extra step to orchestrate.

5. **Pool multi-tenancy; isolation in Postgres RLS, SaaS lens in infra.**
   _Alternatives:_ silo (a stack or database per tenant, which gives strong isolation but costs N× and needs N×
   operations); bridge (a schema per tenant).
   _Rationale:_ many small institutions, so pooled cost efficiency matters. Infrastructure adds tenant-aware
   guard-rails: S3 objects live only under `tenants/{tenantId}/` (the bucket policy **denies** `PutObject` outside
   that prefix, and IAM grants only `tenants/*`, with no `ListBucket`). `tenantId` is in every log line. A metric
   filter, `ErrorsByTenant`, and a saved Logs Insights query give per-tenant error views.
   _Trade-off:_ noisy-neighbour risk is handled with app rate limits and WAF, not hard quotas. The per-tenant metric
   costs scale with tenant count (custom metrics), and CloudWatch may throttle filters above about 1000 distinct
   values an hour.

6. **Least-privilege credential split** (see "Database credentials" above).
   _Alternatives:_ one DB user for everything (simple, but RLS bypass and DDL in every process); IAM DB auth
   (15-minute tokens; workable, but adds a token-refresh code path and connection churn).
   _Rationale:_ the blast radius of a compromised API task is one RLS-fenced role. Only migrations can do DDL.
   _Trade-off:_ three secrets to manage, and the role passwords are not rotated automatically yet (see 7).

7. **Secrets in Secrets Manager, generated by Terraform or RDS, injected by ECS.**
   _Alternatives:_ SSM Parameter Store SecureString (cheaper, but no native rotation or RDS integration); env vars
   in tfvars (secrets in git or CI); Vault (another system to run).
   _Rationale:_ no human ever sees or pastes a secret. The master password is RDS-managed and rotates every 7 days.
   **Generated secrets are not in state** (Terraform ≥ 1.11): `ephemeral "random_password"` / `ephemeral
"random_bytes"` feed write-only arguments, so the value exists only in memory during the run that writes it.

   | Secret                                              | How                                                                                                                  | In state? |
   | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------- |
   | RDS master password                                 | `manage_master_user_password` (RDS generates, stores, rotates every 7 days)                                          | no        |
   | `lending_app` / `lending_worker` passwords          | ephemeral `random_password` → `secret_string_wo`, versioned by `role_password_version`                               | no        |
   | Valkey AUTH token + `REDIS_URL`                     | one ephemeral `random_password` → `auth_token_wo` **and** `secret_string_wo`, both versioned by `auth_token_version` | no        |
   | `JWT_SECRET`, `BVN_HMAC_KEY`, `DATA_ENCRYPTION_KEY` | ephemeral `random_password` / `random_bytes` → `secret_string_wo`, versioned by `app_secret_version`                 | no        |
   | LocalStack app secret                               | same pattern, constant version                                                                                       | no        |

   What state still holds: secret **ARNs and version numbers**, the KMS key IDs, endpoints and every non-secret
   attribute. That is why state stays KMS-encrypted, env-scoped and readable from PRs only after reviewer approval.
   Write-only values are written only when the resource is created or its `*_version` changes; a new ephemeral
   value generated on other runs is discarded. Bumping a version **rotates**: role passwords follow via migrations
   (the pipeline writes the secret before `flyway migrate`), the Valkey token uses the `ROTATE` strategy (old and new
   valid), but app keys must not be bumped until the app supports a dual-key window.
   _Moving an already-applied environment to write-only:_ the first apply writes NEW role passwords and a new Valkey
   token (safe, as above), and would generate NEW app keys. For an environment holding data encrypted with the DEK
   or hashed with the BVN key, set `preserve_existing_app_secret = true` for that one apply (it re-writes the
   current value, read ephemerally; needs the env apply role, so the PR plan for that env fails while it is on), then
   set it back to `false`. Old values remain in state history (bucket versioning, 90 days): treat them as exposed and
   rotate once dual-key support exists.
   App-key and role-password rotation needs app dual-key or reconnect support, and is a checkov-documented
   follow-up. Cost is about $0.40 per secret per month.

8. **A KMS CMK per data domain** (rds, elasticache, secrets, messaging, s3, logs, ecr), all with annual rotation and
   single-region.
   _Alternatives:_ AWS-managed keys (free, but no key-policy control and no cross-service separation); one CMK for
   everything.
   _Rationale:_ IAM can grant the API `Decrypt` on S3 objects but not on SQS. Disabling one key contains an
   incident. CloudTrail shows per-domain key use. Single-region keys keep ciphertext from being decrypted outside
   the region.
   _Trade-off:_ about $1 per key per month (7 keys, plus 1 DR key, per environment) and more key-policy surface.

9. **Network: 3 AZs × public, private and isolated database subnets; NAT per AZ in staging/prod; endpoints
   behind a flag.**
   _Alternatives:_ a single NAT everywhere (an AZ outage cuts egress, including webhooks); no NAT, endpoints only
   (impossible, because the worker delivers webhooks to arbitrary internet hosts); IPv6 egress-only (partners and
   tooling are not ready).
   _Rationale:_ the DB and cache subnets have no route out at all. The S3 gateway endpoint is free and removes NAT
   processing for image layers and uploads. Interface endpoints keep secret and KMS traffic private. Flow logs
   capture ALL traffic at 60 s aggregation for forensics. NAT EIPs are static webhook source IPs for partner
   allow-lists.
   _Trade-off:_ NAT costs about $33/month per AZ plus data processing. Interface endpoints cost about $7.3 per
   endpoint per AZ per month (7 × 3, roughly $150/month), so they are off in dev.

10. **Edge: ALB + WAFv2 + TLS 1.3 policy.**
    _Alternatives:_ CloudFront in front (adds edge PoPs in Lagos, but terminates TLS outside the region and adds
    complexity); API Gateway (per-request pricing and a 29 s timeout).
    _Rationale:_ the AWS managed rule groups (IP reputation, Common, KnownBadInputs including Log4j, SQLi) and two
    per-IP rate rules: a tight one on `/v1/auth/*`, `/v1/platform/auth/*` and
    `/v1/institutions/*/customers/register` against credential stuffing and signup abuse, and a generous global
    one because Nigerian mobile users share carrier-grade NAT IPs. An optional IP allow-list
    (`platform_admin_cidrs`, empty by default, which disables it) blocks `/v1/platform/*` from anywhere except the
    admin network. Authorization and cookie headers are redacted from WAF
    logs. The listener uses `ELBSecurityPolicy-TLS13-1-2-Res-2021-06`, which keeps TLS 1.2 for older Android
    clients with restricted ciphers. `drop_invalid_header_fields` and desync mitigation guard against request
    smuggling. HTTP→HTTPS uses a 301. The ALB → task hop is HTTP inside private subnets, SG to SG.
    _Trade-off:_ WAF costs about $5 per ACL plus $1 per rule per month plus $0.60 per million requests. The
    target hop is not encrypted end to end.

11. **ElastiCache Valkey 8 (cluster mode disabled), TLS required, AUTH token.**
    _Alternatives:_ Redis OSS on ElastiCache (about 20% dearer and a licence change); ElastiCache Serverless
    (higher minimum cost in practice); self-hosted.
    _Rationale:_ wire-compatible with `ioredis`. `transit_encryption_mode = "required"` refuses plaintext. The
    token is set with the `ROTATE` strategy so it can be changed without disconnecting clients. The full
    `rediss://` URL is the secret.
    _Trade-off:_ the AUTH token is less granular than RBAC user groups. A single shard limits write scale, which is
    fine for a rate-limit and cache workload.

12. **SQS standard queue + DLQ (`maxReceiveCount = 5`), SSE-KMS, TLS-only policy, DLQ alarm on depth > 0.**
    _Alternatives:_ FIFO (300 TPS per group, and ordering is already handled by the outbox); EventBridge (no pull
    consumer back-pressure); Kafka/MSK (heavy).
    _Rationale:_ matches the at-least-once outbox with idempotent consumers. The DLQ keeps messages 14 days, and
    the redrive-allow policy limits it to its source queue. Long polling reduces empty receives. A data-key reuse
    period of 300 s cuts KMS calls.
    _Trade-off:_ duplicates are possible by design, and consumers must dedupe on `webhook-id`.

13. **S3 branding bucket:** BPA (all four), BucketOwnerEnforced, SSE-KMS with bucket key, versioning plus
    noncurrent expiry, abort-incomplete-MPU, TLS-only, CORS for presigned PUT from explicit origins.
    _Alternatives:_ proxying uploads through the API (CPU, memory and timeouts); a public bucket for logos (no).
    _Rationale:_ browsers upload directly, and the API only signs URLs. The bucket key cuts KMS cost by up to 99%.
    _Trade-off:_ serving logos needs presigned GET or a future CloudFront with OAC. CRR is deliberately off for
    residency.

14. **ECR: immutable tags, scan on push, lifecycle rules, KMS; deploy by digest; one repository per env.**
    _Alternatives:_ mutable `latest` (what runs becomes unknowable); a single shared repository (simpler, but it
    couples environments and accounts).
    _Rationale:_ the bytes tested in staging are the bytes that run in prod. Per-env repositories carry over
    cleanly to one account per environment.
    _Trade-off:_ the image must be copied between repositories (the digest is preserved), and storage is
    duplicated.

15. **Observability: CloudWatch native** (KMS-encrypted log groups with retention, Container Insights, alarms → an
    encrypted SNS topic). Alarms cover ALB ELB and target 5xx, target p99 latency, ECS CPU and memory, RDS CPU,
    free storage and connections, SQS oldest-message age and DLQ depth.
    _Alternatives:_ Datadog, Grafana Cloud or Honeycomb (better UX, but per-host and per-GB pricing and data
    leaving the region).
    _Rationale:_ zero additional vendors, data stays in-region, and alarms are codified next to the resources
    they watch. p99 rather than the average catches the tail users feel.
    _Trade-off:_ weaker tracing. OpenTelemetry → X-Ray or ADOT is the next step. Thresholds are starting points to
    tune.

16. **Module structure: resource modules + one `platform` composition; environments are thin roots.**
    _Alternatives:_ copy-paste compositions per env (drift between dev and prod); a single root with workspaces
    (one backend config, easy to apply to the wrong env, and no per-env provider guards); Terragrunt (extra tool).
    _Rationale:_ dev and staging rehearse exactly prod's topology. Differences are explicit inputs in each env's
    `main.tf`.
    _Trade-off:_ changing `platform` affects all environments at once, which is mitigated by promoting through
    dev → staging → prod in CI.

17. **State: S3 backend with `use_lockfile = true`, `encrypt = true`, and a separate key per env. No DynamoDB.**
    _Alternatives:_ a DynamoDB lock table (the classic pattern, deprecated in the S3 backend since 1.11); HCP
    Terraform.
    _Rationale:_ S3 conditional writes give native locking from Terraform 1.10, which means one fewer resource, IAM
    path and bill. (`required_version >= 1.11` is driven by write-only secrets, see 7.) The bucket is versioned, SSE-KMS with a dedicated
    CMK, BPA, TLS-only and deny-DeleteBucket. Bootstrap uses local state (chicken-and-egg).
    _Trade-off:_ every environment and CI must be on Terraform ≥ 1.11. Bootstrap state needs manual care.

18. **dev, staging and prod, plus local.**
    _Alternatives:_ dev and prod only (no prod-shaped rehearsal); ephemeral per-PR environments (expensive with
    RDS and NAT).
    _Rationale:_ staging has the same topology as prod (Multi-AZ, NAT per AZ, endpoints, WAF, ≥ 2 tasks, deletion
    protection, DR copy) on smaller instances. It is used for migration rehearsal, partner institution UAT and
    sandbox work (webhooks, branding) and release-candidate verification of the exact digest. **local is a
    LocalStack test target, not a deployment environment.**
    _Trade-off:_ staging costs a meaningful fraction of prod. It can be scaled down out of hours.

19. **CI identity: GitHub OIDC with a customised subject, a reviewer-gated read-only plan role, main-and-workflow-bound
    per-env apply roles, per-env permission boundaries and ABAC.**
    _Alternatives:_ long-lived access keys in GitHub secrets (leak risk, no expiry); a single admin deploy role (one
    compromised workflow can change every environment); one apply role with `PowerUserAccess` (the original draft,
    rejected in security review, see below).
    _Rationale:_
    - **Subject template:** the repository's OIDC `sub` is customised to `repo`, `context`, `ref`,
      `job_workflow_ref`, so branch and workflow are inside `sub`, the claim IAM always evaluates (setup in
      `bootstrap/README.md`).
    - **PR jobs without credentials:** fmt, validate, test, tflint and checkov run `-backend=false` and request no
      OIDC token. A malicious PR therefore cannot read state.
    - **Plan role** (`sub = repo:<repo>:environment:plan:ref:refs/pull/*/merge:job_workflow_ref:<repo>/.github/workflows/infra.yml@refs/pull/*/merge`):
      only after a reviewer approves the `plan` Environment. Reads **non-prod state only** (an explicit Deny on
      `lending/prod/*`). It has **no** `secretsmanager:GetSecretValue`, no lock writes and no ReadOnlyAccess. Plans
      run `-refresh=false -lock=false`, so they diff the proposed config against the last applied state. Drift
      detection happens in the gated apply job. Approval is approval to execute the PR's code with that access.
    - **Apply roles** (`sub = repo:<repo>:environment:<env>:ref:refs/heads/main:job_workflow_ref:<repo>/.github/workflows/infra.yml@refs/heads/main`):
      only a job bound to that GitHub Environment, on `main`, in the deploy workflow as committed to `main`, can
      assume one. Environments allow deployments from `main` only and prod requires reviewers (GitHub side); the
      trust policy enforces the same independently (AWS side). Each role is limited to its own state key, its own
      `lending-<env>/*` secrets, `lending-<env>-*` names and its own regions. **No managed admin or power-user
      policy:** permissions are explicit per-service statements in five customer-managed policies (to stay under
      the 6 KiB per-policy limit). The rendered sizes are 1.1 to 4.2 KiB, measured on LocalStack.
    - **Route 53 health checks: prod role only.** Route 53 has no tag-based authorisation and health-check IDs are
      random, so neither ABAC nor names can confine them; any role allowed `UpdateHealthCheck` could disable another
      tier's failover. Non-prod roles have an explicit Deny, and the `global` stack creates health checks for the
      prod tier only (non-prod relies on ALB `evaluate_target_health`).
    - **Privilege escalation is closed:**
      `iam:CreateRole/PutRolePolicy/PutRolePermissionsBoundary/UpdateAssumeRolePolicy/AttachRolePolicy` require
      `iam:PermissionsBoundary = lending-boundary-<env>`. `AttachRolePolicy` also requires `iam:PolicyARN` to be a
      project policy or `AmazonRDSEnhancedMonitoringRole`, never Administrator, IAMFullAccess or PowerUser.
      `iam:PassRole` is limited to `ecs-tasks`, `monitoring.rds` and `vpc-flow-logs`. There are explicit Denies on
      `DeleteRolePermissionsBoundary`, on any change to any boundary policy and on the CI roles themselves (named
      `github-lending-*`, outside the writable `lending-<env>-*` namespace).
    - **Per-env boundaries** (`lending-boundary-<env>`): roles created by the dev pipeline can reach only dev
      queues, objects, secrets (including the RDS master secret, matched on its `aws:rds:primaryDBInstanceArn`
      tag), keys (`alias/lending-<env>-*`) and log groups.
    - **ABAC for ID-addressed resources (EC2):** create actions need `aws:RequestTag/Environment = <env>` with
      `aws:TagKeys` restricted to an allow-list. Modify and delete actions need `ec2:ResourceTag/Environment =
<env>`. A global Deny blocks any action on a resource tagged with a different Environment, or a request that
      stamps another environment's tag. Provider `default_tags` guarantees every resource is tagged at creation.
      _Trade-off:_ explicit allow-lists can miss an action on the first apply. The fix is to iterate in dev and then
      tighten with IAM Access Analyzer policy generation from CloudTrail. **Production recommendation: one AWS
      account per environment under AWS Organizations with SCPs.** The account is then the hard boundary, and ABAC
      becomes defence in depth. The single-account layout here is a deliberate simplification of that model.

20. **Testing: native `terraform test` with `mock_provider`, plus tflint and checkov.**
    _Alternatives:_ Terratest (Go, real resources, slow and costly); plan-JSON plus OPA (another language).
    _Rationale:_ the tests are free, run in seconds and need no credentials. They assert encryption, BPA, DLQ
    redrive, TLS-only policies, WAF rule scope and the admin allow-list, the tenant-prefix guard, the secret split, container hardening and variable
    validation, write-only secrets (nothing in `secret_string` / `auth_token`), and the rendered CI trust and DNS
    policies. Terraform 1.11 mocks cannot mock ephemeral resources, so the bootstrap, security and platform tests
    use the **real provider offline** (credential checks skipped, identity data sources overridden), which also
    renders the IAM JSON for real. A few runs use
    `command = apply` **against the mock**, because Terraform fills computed
    attributes such as ARNs only during apply. checkov has **no global skips**: each exception is an inline
    `#checkov:skip` with its reason.
    _Trade-off:_ mocks prove the configuration, not AWS behaviour. LocalStack and a dev apply cover that.

21. **Fargate ARM64 (Graviton).**
    _Alternatives:_ x86_64.
    _Rationale:_ about 20% cheaper per vCPU-hour, which offsets part of the region premium.
    _Trade-off:_ the image must be built for `linux/arm64` (or multi-arch). This is a one-line switch
    (`cpu_architecture`).

22. **Container hardening.** Distroless runtime (ENTRYPOINT `/nodejs/bin/node`, so the ECS `command` is just the
    script, and the container health check uses exec form because there is no shell), non-root `65532:65532`, read-only root filesystem with a writable `/tmp` volume,
    `initProcessEnabled` (tini) so SIGTERM reaches Node, `stopTimeout` of 30 s for the API and 120 s for the
    worker drain, a liveness container check (`/health/live`) distinct from ALB readiness (`/health/ready`), a
    circuit breaker with rollback, and `ignore_changes = [desired_count]` so applies do not fight autoscaling.
    Autoscaling uses CPU target tracking plus ALB `RequestCountPerTarget` for the API.

23. **Global control plane = DynamoDB global table for the tenant directory, plus Route 53 for routing.**
    _Alternatives:_
    - **Aurora Global Database**: one writer region, with cross-region reads lagging by about 1 s. Writes from
      other cells cross regions, failover has to be managed, and there is a large always-on cost. It is overkill
      for a few thousand small rows.
    - **Route 53 per-tenant records** (`<slug>.api.<domain>` → cell): no runtime lookup, but DNS caching and TTLs
      delay moves, every onboarding becomes a DNS change (API rate limits, and CI permissions on the zone), and
      the tenant list becomes publicly enumerable.
    - **CloudFront KeyValueStore + CloudFront Functions**: routing at the edge before any cell is hit. However,
      CloudFront terminates TLS outside the region, the store is eventually consistent with a size limit, writes
      go through a control-plane API, and it adds CloudFront to the request path (WAF and logging again).

    _Rationale:_ multi-active replicas mean every cell reads its **local** copy (single-digit ms, no cross-region
    call on the request path) and keeps working when another region is down. Conditional writes give global slug
    uniqueness. On-demand billing costs cents at this size. Per-region CMKs and PITR follow the same conventions
    as the cells. Route 53 health-checked geolocation only provides a best first guess, and the directory plus
    307/421 makes routing correct.
    _Trade-off:_ last-writer-wins conflict resolution between regions. This is acceptable because only the
    worker in the tenant's home cell writes its entry. A globally replicated table is the one deliberate
    cross-region data flow, which is why its content is limited to non-personal routing metadata. Route 53 costs
    about $0.50 per health check per month and $0.70 per million geo queries.

## checkov exceptions (all inline, with reason)

| Check                               | Where                                              | Why                                                                                                                           |
| ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CKV_AWS_145                         | ALB log bucket                                     | ALB access-log delivery supports only SSE-S3                                                                                  |
| CKV_AWS_18                          | log, state and branding buckets                    | auditing is done with CloudTrail data events; logging the log bucket would recurse                                            |
| CKV_AWS_144                         | buckets                                            | CRR is off deliberately (data residency)                                                                                      |
| CKV2_AWS_62                         | buckets                                            | no event consumers                                                                                                            |
| CKV2_AWS_57                         | secrets                                            | rotation needs app dual-key or reconnect support (planned)                                                                    |
| CKV2_AWS_64                         | DR, directory, state and LocalStack KMS keys       | the default root-delegation policy is intended; access is via IAM                                                             |
| CKV_AWS_109/111/356                 | key policies, ECR auth, Describe APIs, CI policies | `"*"` means "this key", or the API has no resource-level permissions; writes are name-, ABAC- or boundary-scoped              |
| CKV_AWS_290                         | CI compute policy                                  | writes are ABAC-, name- or region-scoped                                                                                      |
| CKV_AWS_356/111                     | CI DNS policy                                      | `route53:CreateHealthCheck` (prod role only) has no resource-level permissions; record writes are limited by normalized name  |
| CKV_AWS_31                          | Valkey replication group                           | false positive: the AUTH token is set through write-only `auth_token_wo` (checkov reads only `auth_token`); TLS is `required` |
| CKV_AWS_260, CKV_AWS_2, CKV_AWS_103 | ALB :80                                            | it only issues a 301 to HTTPS                                                                                                 |
| CKV_AWS_378                         | target group                                       | TLS terminates at the ALB; the hop is private and SG-restricted                                                               |
| CKV_AWS_150                         | ALB                                                | deletion protection is per env (on in staging and prod)                                                                       |
| CKV_AWS_338                         | WAF log group                                      | retention is per env (prod 365 days)                                                                                          |
| CKV_AWS_65                          | ECS cluster                                        | variable-driven; validation allows only `enabled` or `enhanced`                                                               |
| CKV2_AWS_76                         | ALB                                                | the Log4j AMR (KnownBadInputs) is in the web ACL, attached through a separate resource                                        |
| CKV_AWS_394                         | AZ data source                                     | `slice(0, az_count)` of sorted names is stable                                                                                |
| CKV_TF_1                            | vpc module                                         | registry source pinned to an exact version                                                                                    |

## Not verified / follow-ups

- Nothing here has been applied to a real AWS account. The only checks are `validate`, mocks and LocalStack
  (`environments/local` applied cleanly and re-planned with no changes; bootstrap rendered on LocalStack to
  measure policy sizes). Expect to iterate on the explicit CI allow-lists during the first dev apply.
- RDS tagging its managed master secret with `aws:rds:primaryDBInstanceArn`, used by the boundary condition, is
  believed correct but should be confirmed on the first apply.
- Cross-region automated backup replication from af-south-1 to eu-west-2, and Valkey 8 and the m6g node types in
  af-south-1: check availability in the console before prod.
- `DATA_ENCRYPTION_KEY` is produced as base64 of 32 random bytes. Confirm the app decodes it that way.
- Rotation for app keys and role passwords (write-only versions exist; the app dual-key window does not);
  confirm on the first apply that `replace_triggered_by` re-writes `REDIS_URL` when the Valkey group is replaced;
  ECS Fargate ephemeral-storage CMK;
  OpenTelemetry tracing; CloudFront + OAC for logos.
