# global

This is the global control plane for one environment tier. It holds the tenant directory (`modules/directory`)
and the Route 53 routing (`modules/edge`). See the root README section "Multi-region cells & global routing".

```bash
terraform init -backend-config="bucket=lending-tfstate-<acct>" -backend-config="key=lending/prod/global/terraform.tfstate"
terraform apply                                   # 1st: directory only (cells = {})
# deploy the cells (environments/prod, environments/prod-euw3, ...), then fill `cells` and:
terraform apply                                   # 2nd: per-cell records, geolocation, health checks
```

The state sits under the tier's prefix (`lending/<env>/global/...`), so the tier's apply role owns it, and
resources are tagged `Environment=<env>` to satisfy the apply role's ABAC.
