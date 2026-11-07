# cache

ElastiCache **Valkey** replication group (cluster mode disabled) in the isolated subnets.

- `transit_encryption_mode = "required"`, AUTH token (64 alphanumerics, `ROTATE` update strategy), and
  encryption at rest with a CMK.
- `num_cache_clusters` and `automatic_failover_enabled` (validated: failover needs at least 2 nodes, and also
  turns on Multi-AZ).
- The slow log goes to a KMS-encrypted log group.
- Secret `<name>/redis` has the JSON keys `auth_token` and `url` (`rediss://:<token>@<primary>:6379`). Inject
  `url` as `REDIS_URL`.
