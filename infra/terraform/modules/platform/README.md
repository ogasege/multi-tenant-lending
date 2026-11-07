# platform

This module composes every module into one environment, or one **cell** when `cell_id` is set; see the root
README. `environments/{dev,staging,prod}` are thin roots that call it with environment-specific sizing.

It wires the SPEC §12 runtime contract (plain env vars, plus secrets by JSON key) and the least-privilege secret
split:

| Workload                             | Secrets                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| api                                  | app keys, REDIS_URL, `lending_app` password                                                                                      |
| worker                               | app keys, REDIS_URL, `lending_worker` password (cross-tenant jobs) and `lending_app` password (RLS-enforced tenant-scoped reads) |
| migrate (Flyway image, own ECR repo) | RDS master (`DATABASE_MIGRATOR_USER/PASSWORD`), `lending_app` and `lending_worker` passwords                                     |

`CELL_REGION` and `AWS_REGION` are set to the cell's region. `CELL_ORIGIN_SUFFIX` (`.<api_domain>`), the optional
`CELL_ORIGINS`, the rate limits (`rate_limits`), `KYC_PROVIDER`, `PAYMENT_PROVIDER`, `CREDIT_BUREAU_PROVIDER` and
`CHECKOUT_ORDERS_PROVIDER` (API only; `mock` is rejected for prod) and `REPAYMENT_MAX_BACKDATE_DAYS` (API only,
0–31, default 3) are set as plain env vars. The API's task role can reserve slugs (`GetItem/PutItem/DeleteItem`) on the cell's directory
replica.
