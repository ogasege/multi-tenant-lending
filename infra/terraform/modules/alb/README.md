# alb

Internet-facing ALB for the API.

* An HTTPS :443 listener with an ACM certificate (validated ARN) and a TLS 1.3 policy (default
  `ELBSecurityPolicy-TLS13-1-2-Res-2021-06`; validation requires `ELBSecurityPolicy-TLS13-*`). HTTP :80 only
  returns a 301 to HTTPS.
* `drop_invalid_header_fields`, desync mitigation `defensive`, HTTP/2, TLS version and cipher headers, and
  optional deletion protection.
* The target group is `ip`, HTTP :3000, with a health check on `/health/ready` (2 healthy, 3 unhealthy, every
  15 s) and a 30 s deregistration delay.
* Access logs go to a dedicated bucket: SSE-S3 (the only option ALB supports), BPA, TLS-only, versioned and
  lifecycle-expired, writable only by the regional ELB log-delivery account.
* `associate_waf` and `web_acl_arn` attach the WAF web ACL.
