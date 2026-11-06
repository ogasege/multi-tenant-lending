data "aws_caller_identity" "current" {}

# Regional ELB log-delivery account (differs per region; af-south-1 and
# other pre-2022 regions use an account principal, not a service one).
data "aws_elb_service_account" "this" {}

locals {
  log_bucket_name = "${var.name}-alb-logs-${data.aws_caller_identity.current.account_id}"
  log_prefix      = "alb"
}

# ---------------------------------------------------------------------
# Access-log bucket
# ---------------------------------------------------------------------

resource "aws_s3_bucket" "logs" {
  # ALB log delivery supports only SSE-S3; SSE-KMS makes delivery fail.
  #checkov:skip=CKV_AWS_145:ALB access logs support SSE-S3 only
  # Logging the log bucket creates infinite regress; CloudTrail covers it.
  #checkov:skip=CKV_AWS_18:This is the log bucket
  #checkov:skip=CKV_AWS_144:Logs stay in-region (residency); retention is lifecycle-bound
  #checkov:skip=CKV2_AWS_62:No event consumers for access logs
  bucket        = local.log_bucket_name
  force_destroy = var.force_destroy_log_bucket
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.access_log_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.logs]
}

data "aws_iam_policy_document" "logs" {
  statement {
    sid       = "AllowElbLogDelivery"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/${local.log_prefix}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.this.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs.json

  depends_on = [aws_s3_bucket_public_access_block.logs]
}

# ---------------------------------------------------------------------
# Security group
# ---------------------------------------------------------------------

resource "aws_security_group" "this" {
  name        = "${var.name}-alb"
  description = "Public HTTPS ingress for the ${var.name} API ALB"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-alb"
  }
}

resource "aws_vpc_security_group_ingress_rule" "https" {
  security_group_id = aws_security_group.this.id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# Port 80 exists only to 301-redirect to HTTPS (no content is served).
resource "aws_vpc_security_group_ingress_rule" "http" {
  #checkov:skip=CKV_AWS_260:Port 80 only issues a 301 redirect to HTTPS
  security_group_id = aws_security_group.this.id
  description       = "HTTP from the internet (redirect only)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

# Egress to the tasks is added by the ecs-service module (it owns the
# task security group), avoiding a module dependency cycle.

# ---------------------------------------------------------------------
# Load balancer
# ---------------------------------------------------------------------

resource "aws_lb" "this" {
  # Variable-driven: true in staging/prod, false in dev so it can be torn down.
  #checkov:skip=CKV_AWS_150:Deletion protection is per-env (on in staging/prod)
  # WAF (incl. KnownBadInputs = Log4j AMR) is associated via a separate
  # resource with a module-input ARN, which checkov cannot follow.
  #checkov:skip=CKV2_AWS_76:Log4j AMR is in the security module web ACL
  name               = "${var.name}-api"
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.this.id]

  # Malformed header names are a request-smuggling vector; drop them.
  drop_invalid_header_fields = true
  # "defensive" blocks the most dangerous desync patterns while keeping
  # compatibility with older mobile HTTP stacks ("strictest" can 400 them).
  desync_mitigation_mode     = "defensive"
  enable_deletion_protection = var.deletion_protection
  enable_http2               = true
  idle_timeout               = 60

  # Adds X-Amzn-Tls-Version / Cipher headers so the app can log them.
  enable_tls_version_and_cipher_suite_headers = true

  access_logs {
    enabled = true
    bucket  = aws_s3_bucket.logs.id
    prefix  = local.log_prefix
  }

  depends_on = [aws_s3_bucket_policy.logs]
}

# HTTP (not HTTPS) to the target: TLS terminates at the ALB and the hop
# to the task stays inside private subnets guarded by security groups.
# End-to-end TLS would need certs in every container for little gain.
resource "aws_lb_target_group" "api" {
  #checkov:skip=CKV_AWS_378:TLS terminates at the ALB; target hop is private and SG-restricted
  name        = "${var.name}-api"
  port        = var.target_port
  protocol    = "HTTP"
  target_type = "ip" # required for Fargate awsvpc networking
  vpc_id      = var.vpc_id

  # Short drain: API requests are short-lived and the app has graceful
  # shutdown; 30s keeps deploys fast without cutting in-flight calls.
  deregistration_delay = 30

  # Readiness (Postgres + Redis reachable), not liveness: a task that
  # cannot reach its dependencies should stop receiving traffic.
  health_check {
    path                = var.health_check_path
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  # TLS 1.3 preferred, TLS 1.2 floor with forward-secret AEAD ciphers
  # only ("Res" = restricted). 1.2 is kept for older Android devices.
  ssl_policy      = var.ssl_policy
  certificate_arn = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2:Listener only redirects to HTTPS
  #checkov:skip=CKV_AWS_103:Listener only redirects to HTTPS
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_wafv2_web_acl_association" "this" {
  count = var.associate_waf ? 1 : 0

  resource_arn = aws_lb.this.arn
  web_acl_arn  = var.web_acl_arn

  lifecycle {
    precondition {
      condition     = var.web_acl_arn != null
      error_message = "web_acl_arn must be set when associate_waf = true."
    }
  }
}
