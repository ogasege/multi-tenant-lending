# ---------------------------------------------------------------------
# Per-environment workload permissions boundaries
# ---------------------------------------------------------------------
#
# Every IAM role the <env> apply role creates MUST carry the <env>
# boundary (enforced by iam:PermissionsBoundary conditions in
# ci_roles.tf). A role's effective permissions are the INTERSECTION of
# its policies and its boundary, so even if a pipeline - or a malicious
# PR that reached apply - attaches an over-broad policy to a project
# role, that role can only touch ITS OWN environment's queues, objects,
# secrets and keys. No IAM, no STS role chaining, no account actions.
#
# Named "<project>-boundary-<env>", i.e. OUTSIDE the
# "<project>-<env>-*" namespace apply roles can write to, and explicitly
# deny-protected as well.

data "aws_iam_policy_document" "boundary" {
  for_each = var.environments

  # GetAuthorizationToken and logs:DescribeLogGroups have no resource-
  # level permissions; "*" is the only valid resource for them.
  #checkov:skip=CKV_AWS_356:Only actions without resource-level support use "*"
  #checkov:skip=CKV_AWS_111:Writes are limited to this environment's resource names

  statement {
    sid       = "NoResourceLevelSupport"
    actions   = ["ecr:GetAuthorizationToken", "logs:DescribeLogGroups"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPullOwnRepos"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = ["${local.arn}:ecr:*:${local.acct}:repository/${var.project}-${each.key}*/*"]
  }

  # awslogs driver and VPC flow logs write to log groups whose names
  # contain "<project>-<env>"; RDS Enhanced Monitoring writes to the
  # AWS-defined RDSOSMetrics group.
  statement {
    sid = "WriteOwnLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:PutRetentionPolicy",
      "logs:DescribeLogStreams",
      "logs:GetLogEvents",
    ]
    resources = [
      "${local.arn}:logs:*:${local.acct}:log-group:*${var.project}-${each.key}*",
      "${local.arn}:logs:*:${local.acct}:log-group:RDSOSMetrics*",
    ]
  }

  # Env modules name secrets "<project>-<env>/...".
  statement {
    sid       = "ReadOwnSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.arn}:secretsmanager:*:${local.acct}:secret:${var.project}-${each.key}*/*"]
  }

  # RDS-managed master secrets are named rds!db-<uuid> (no env in the
  # name). RDS tags them with aws:rds:primaryDBInstanceArn, so scope by
  # the owning instance, whose identifier starts with <project>-<env>-.
  statement {
    sid       = "ReadOwnRdsMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["${local.arn}:secretsmanager:*:${local.acct}:secret:rds!*"]

    condition {
      test     = "StringLike"
      variable = "secretsmanager:ResourceTag/aws:rds:primaryDBInstanceArn"
      values   = ["${local.arn}:rds:*:${local.acct}:db:${var.project}-${each.key}-*"]
    }
  }

  statement {
    sid       = "UseOwnKeys"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = ["${local.arn}:kms:*:${local.acct}:key/*"]

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "kms:ResourceAliases"
      values   = ["alias/${var.project}-${each.key}-*"]
    }
  }

  statement {
    sid = "OwnQueues"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = ["${local.arn}:sqs:*:${local.acct}:${var.project}-${each.key}-*"]
  }

  # Tenant directory (global table) of this tier, any cell region.
  statement {
    sid = "OwnTenantDirectory"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:ConditionCheckItem",
    ]
    resources = ["${local.arn}:dynamodb:*:${local.acct}:table/${var.project}-${each.key}-tenant-directory"]
  }

  statement {
    sid       = "OwnTenantObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${local.arn}:s3:::${var.project}-${each.key}-*/tenants/*"]
  }
}

resource "aws_iam_policy" "boundary" {
  for_each = var.environments

  name        = "${var.project}-boundary-${each.key}"
  description = "Permissions boundary for every role the ${each.key} pipeline creates"
  policy      = data.aws_iam_policy_document.boundary[each.key].json
}
