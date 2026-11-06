# storage

S3 bucket for tenant branding assets. Objects live at `tenants/{tenantId}/...`.

* Block Public Access (all four), `BucketOwnerEnforced` (ACLs disabled), and SSE-KMS with a **bucket key**.
* Versioning, with noncurrent versions expiring after `noncurrent_version_expiration_days` (default 30),
  incomplete multipart uploads aborted after 1 day, and expired delete markers removed.
* Bucket policy: **deny non-TLS**, and **deny `PutObject` outside `tenant_prefix`** (the SaaS isolation
  guard-rail).
* CORS allows `PUT`, `GET` and `HEAD` from explicit origins only (validated: no wildcards) for browser uploads
  with presigned URLs.
* Output `tenant_objects_arn` (`<bucket>/tenants/*`) is what workload IAM policies are given.

Tests: `terraform test` (`tests/storage.tftest.hcl`).
