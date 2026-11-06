# ---------------------------------------------------------------------
# GitHub Actions OIDC federation
# ---------------------------------------------------------------------
#
# Short-lived (1 h) credentials per workflow run instead of long-lived
# access keys stored as GitHub secrets. AWS validates GitHub's OIDC
# signing chain itself, so no thumbprint pinning is needed.
#
# Trust model:
#   github-<project>-plan          sub = repo:<repo>:pull_request
#     read-only, NON-PROD state only, no secret values, no lock writes
#   github-<project>-apply-<env>   sub = repo:<repo>:environment:<env>
#     only reachable from a job bound to that GitHub Environment (prod
#     has required reviewers), only its own state key / names / secrets,
#     only roles carrying the <env> boundary, ABAC on Environment tag.
#
# Production recommendation: one AWS account per environment under AWS
# Organizations with SCPs - the account is then the hard boundary and
# most of the ABAC below becomes defence in depth. This single-account
# layout is a take-home simplification.

locals {
  regions = distinct(concat([var.aws_region, var.dr_region], var.cell_regions))

  # Tag keys the pipeline may set (provider default_tags + module tags).
  allowed_tag_keys = [
    "Project", "Environment", "Owner", "CostCenter", "DataClassification",
    "ManagedBy", "Name", "Tier", "Workload", "DataDomain",
  ]

  ec2_create_actions = [
    "ec2:CreateVpc",
    "ec2:CreateSubnet",
    "ec2:CreateRouteTable",
    "ec2:CreateInternetGateway",
    "ec2:CreateNatGateway",
    "ec2:AllocateAddress",
    "ec2:CreateSecurityGroup",
    "ec2:AuthorizeSecurityGroupIngress",
    "ec2:AuthorizeSecurityGroupEgress",
    "ec2:CreateVpcEndpoint",
    "ec2:CreateFlowLogs",
    "ec2:CreateNetworkAcl",
  ]

  ec2_modify_actions = [
    "ec2:ModifyVpcAttribute",
    "ec2:DeleteVpc",
    "ec2:ModifySubnetAttribute",
    "ec2:DeleteSubnet",
    "ec2:AssociateRouteTable",
    "ec2:DisassociateRouteTable",
    "ec2:ReplaceRouteTableAssociation",
    "ec2:CreateRoute",
    "ec2:ReplaceRoute",
    "ec2:DeleteRoute",
    "ec2:DeleteRouteTable",
    "ec2:AttachInternetGateway",
    "ec2:DetachInternetGateway",
    "ec2:DeleteInternetGateway",
    "ec2:DeleteNatGateway",
    "ec2:AssociateAddress",
    "ec2:DisassociateAddress",
    "ec2:ReleaseAddress",
    "ec2:RevokeSecurityGroupIngress",
    "ec2:RevokeSecurityGroupEgress",
    "ec2:ModifySecurityGroupRules",
    "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
    "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
    "ec2:DeleteSecurityGroup",
    "ec2:ModifyVpcEndpoint",
    "ec2:DeleteVpcEndpoints",
    "ec2:DeleteFlowLogs",
    "ec2:CreateNetworkAclEntry",
    "ec2:ReplaceNetworkAclEntry",
    "ec2:DeleteNetworkAclEntry",
    "ec2:ReplaceNetworkAclAssociation",
    "ec2:DeleteNetworkAcl",
    "ec2:DeleteTags",
  ]
  arn  = "arn:${local.partition}"
  acct = local.account_id
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url            = "https://${local.github_host}"
  client_id_list = ["sts.amazonaws.com"]
}

# ---------------------------------------------------------------------
# PR plan role (read-only, non-prod)
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "plan_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Exact match: PRs of THIS repo only (fork PRs get no OIDC token for
    # pull_request events by default either).
    condition {
      test     = "StringEquals"
      variable = "${local.github_host}:sub"
      values   = ["repo:${var.github_repository}:pull_request"]
    }
  }
}

resource "aws_iam_role" "plan" {
  name                 = "${local.ci_prefix}-plan"
  description          = "PR terraform plan (read-only, non-prod state) for ${var.github_repository}"
  assume_role_policy   = data.aws_iam_policy_document.plan_trust.json
  max_session_duration = 3600
}

# PR plans run `terraform plan -refresh=false -lock=false`: they diff
# the proposed config against the last applied state and read nothing
# else from AWS except the few data sources (AZ list). That is why this
# role needs no ReadOnlyAccess, no GetSecretValue and no lock-file
# writes. Real drift detection happens in the gated apply job.
data "aws_iam_policy_document" "plan" {
  #checkov:skip=CKV_AWS_356:ec2:DescribeAvailabilityZones has no resource-level permissions

  # ListBucket reveals key NAMES only. Not prefix-conditioned because
  # the S3 backend also lists the workspace prefix ("env:/") on init.
  statement {
    sid       = "ListStateKeys"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }

  statement {
    sid       = "ReadNonProdState"
    actions   = ["s3:GetObject"]
    resources = [for e in local.nonprod_envs : "${aws_s3_bucket.state.arn}/${var.project}/${e}/*"]
  }

  statement {
    sid       = "DecryptState"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.state.arn]
  }

  statement {
    sid       = "DataSources"
    actions   = ["ec2:DescribeAvailabilityZones"]
    resources = ["*"]
  }

  # Belt and braces: even if a broader policy is attached later, prod
  # state stays unreadable from a pull request.
  statement {
    sid       = "DenyProdState"
    effect    = "Deny"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.state.arn}/${var.project}/prod/*"]
  }
}

resource "aws_iam_role_policy" "plan" {
  name   = "terraform-plan"
  role   = aws_iam_role.plan.id
  policy = data.aws_iam_policy_document.plan.json
}

# ---------------------------------------------------------------------
# Per-environment apply roles
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "apply_trust" {
  for_each = var.environments

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_host}:sub"
      values   = ["repo:${var.github_repository}:environment:${each.key}"]
    }
  }
}

resource "aws_iam_role" "apply" {
  for_each = var.environments

  name                 = "${local.ci_prefix}-apply-${each.key}"
  description          = "terraform apply for ${each.key} (GitHub Environment ${each.key})"
  assume_role_policy   = data.aws_iam_policy_document.apply_trust[each.key].json
  max_session_duration = 3600
}

# Policy 1/5: IAM (boundary-enforced), state, explicit denies.
data "aws_iam_policy_document" "apply_iam_state" {
  for_each = var.environments

  #checkov:skip=CKV_AWS_111:IAM writes require the workload boundary and project names
  #checkov:skip=CKV_AWS_356:DeleteRolePermissionsBoundary deny must cover all roles
  #checkov:skip=CKV_AWS_109:IAM changes are boundary-conditioned and name-scoped

  # Creating a role, or adding inline policy / boundary to it, is only
  # allowed when the role carries the workload boundary.
  statement {
    sid = "WriteRolesOnlyWithBoundary"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:UpdateAssumeRolePolicy",
    ]
    resources = ["${local.arn}:iam::${local.acct}:role/${var.project}-${each.key}-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arns[each.key]]
    }
  }

  # Attaching managed policies: boundary required AND the policy must be
  # a project policy or the one AWS-managed policy we use. Never
  # AdministratorAccess / IAMFullAccess / PowerUserAccess.
  statement {
    sid       = "AttachOnlyProjectPolicies"
    actions   = ["iam:AttachRolePolicy"]
    resources = ["${local.arn}:iam::${local.acct}:role/${var.project}-${each.key}-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arns[each.key]]
    }

    condition {
      test     = "ArnLike"
      variable = "iam:PolicyARN"
      values = [
        "${local.arn}:iam::${local.acct}:policy/${var.project}-${each.key}-*",
        "${local.arn}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole",
      ]
    }
  }

  # Read / remove / tag operations cannot raise privileges.
  statement {
    sid = "ManageOwnRoles"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
      "iam:DeleteRole",
    ]
    resources = ["${local.arn}:iam::${local.acct}:role/${var.project}-${each.key}-*"]
  }

  statement {
    sid = "ManageOwnPolicies"
    actions = [
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = ["${local.arn}:iam::${local.acct}:policy/${var.project}-${each.key}-*"]
  }

  statement {
    sid       = "ReadBoundaryAndAwsPolicies"
    actions   = ["iam:GetPolicy", "iam:GetPolicyVersion"]
    resources = [local.boundary_arns[each.key], "${local.arn}:iam::aws:policy/*"]
  }

  # PassRole only to the services that actually assume project roles.
  statement {
    sid       = "PassOwnRolesToWorkloadServices"
    actions   = ["iam:PassRole"]
    resources = ["${local.arn}:iam::${local.acct}:role/${var.project}-${each.key}-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values = [
        "ecs-tasks.amazonaws.com",
        "monitoring.rds.amazonaws.com",
        "vpc-flow-logs.amazonaws.com",
      ]
    }
  }

  statement {
    sid       = "CreateServiceLinkedRoles"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["${local.arn}:iam::${local.acct}:role/aws-service-role/*"]

    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "ecs.amazonaws.com",
        "rds.amazonaws.com",
        "elasticache.amazonaws.com",
        "elasticloadbalancing.amazonaws.com",
        "ecs.application-autoscaling.amazonaws.com",
        "replication.dynamodb.amazonaws.com",
      ]
    }
  }

  statement {
    sid       = "DenyBoundaryRemoval"
    effect    = "Deny"
    actions   = ["iam:DeleteRolePermissionsBoundary"]
    resources = ["*"]
  }

  # No apply role may change ANY environment's boundary.
  statement {
    sid    = "DenyBoundaryTampering"
    effect = "Deny"
    actions = [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = values(local.boundary_arns)
  }

  # ABAC guard-rail across ALL services: anything already tagged with a
  # different Environment is untouchable (reads included). New resources
  # have no tag yet, so creates are governed by the Allow statements.
  # (State bucket/key and boundaries are excluded: they carry no
  # Environment tag by design, and are guarded by their own statements.)
  statement {
    sid     = "DenyOtherEnvironmentsResources"
    effect  = "Deny"
    actions = ["*"]
    not_resources = concat(
      [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*", aws_kms_key.state.arn],
      values(local.boundary_arns),
    )

    condition {
      test     = "StringNotEquals"
      variable = "aws:ResourceTag/Environment"
      values   = [each.key]
    }

    condition {
      test     = "Null"
      variable = "aws:ResourceTag/Environment"
      values   = ["false"]
    }
  }

  # Nor can a request stamp another environment's tag on anything.
  statement {
    sid       = "DenyTaggingAsOtherEnvironment"
    effect    = "Deny"
    actions   = ["*"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestTag/Environment"
      values   = [each.key]
    }

    condition {
      test     = "Null"
      variable = "aws:RequestTag/Environment"
      values   = ["false"]
    }
  }

  # The CI roles themselves are off-limits (no self-escalation).
  statement {
    sid     = "DenyCiRoleChanges"
    effect  = "Deny"
    actions = ["iam:*"]
    resources = [
      "${local.arn}:iam::${local.acct}:role/${local.ci_prefix}-*",
      "${local.arn}:iam::${local.acct}:policy/${local.ci_prefix}-*",
    ]
  }

  # State: this environment's key only - dev cannot touch prod state.
  statement {
    sid       = "ListStateKeys"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn]
  }

  statement {
    sid       = "ReadWriteOwnState"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.state.arn}/${var.project}/${each.key}/*"]
  }

  statement {
    sid       = "UseStateKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.state.arn]
  }
}

# Policy 2/5: read-only Describe/List/Get for refresh. These APIs
# largely lack resource-level permissions; region-restricted.
data "aws_iam_policy_document" "apply_read" {
  for_each = var.environments

  #checkov:skip=CKV_AWS_356:Describe/List APIs do not support resource-level permissions

  statement {
    sid = "Describe"
    actions = [
      "ec2:Describe*",
      "rds:Describe*",
      "rds:ListTagsForResource",
      "elasticache:Describe*",
      "elasticache:ListTagsForResource",
      "elasticloadbalancing:Describe*",
      "wafv2:GetWebACL",
      "wafv2:GetLoggingConfiguration",
      "wafv2:GetWebACLForResource",
      "wafv2:ListTagsForResource",
      "wafv2:ListWebACLs",
      "ecs:Describe*",
      "ecs:List*",
      "ecr:DescribeRepositories",
      "ecr:GetLifecyclePolicy",
      "ecr:ListTagsForResource",
      "logs:Describe*",
      "logs:ListTagsForResource",
      "logs:ListTagsLogGroup",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:ListTagsForResource",
      "sns:GetTopicAttributes",
      "sns:GetSubscriptionAttributes",
      "sns:ListSubscriptionsByTopic",
      "sns:ListTagsForResource",
      "sqs:GetQueueAttributes",
      "sqs:ListQueueTags",
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:ListAliases",
      "kms:ListResourceTags",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetResourcePolicy",
      "application-autoscaling:Describe*",
      "application-autoscaling:ListTagsForResource",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = local.regions
    }
  }
}

# Policy 3/5: network, edge and compute.
data "aws_iam_policy_document" "apply_compute" {
  for_each = var.environments

  #checkov:skip=CKV_AWS_356:EC2 IDs have no name-based ARNs (ABAC on Environment tag); task-def and autoscaling APIs lack resource-level support
  #checkov:skip=CKV_AWS_111:Writes are ABAC- (Environment tag), name- or region-scoped
  #checkov:skip=CKV_AWS_290:Writes are ABAC- (Environment tag), name- or region-scoped

  # EC2 network resources have ID-based ARNs, so they are scoped by
  # ABAC instead of by name. A call is authorised per resource it
  # touches: the NEW resource matches Ec2CreateTaggedForThisEnv (request
  # must carry Environment=<env>), the EXISTING parent (VPC, SG, route
  # table) matches Ec2ModifyOwnEnvironment (must already be tagged
  # <env>). The global Deny in policy 1/5 blocks other envs' resources.
  statement {
    sid       = "Ec2CreateTaggedForThisEnv"
    actions   = local.ec2_create_actions
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = [each.key]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = local.allowed_tag_keys
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = local.regions
    }
  }

  # Tag-on-create is authorised as ec2:CreateTags within the create call.
  statement {
    sid       = "Ec2TagOnCreate"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = local.ec2_create_actions
    }
  }

  # VPC-owned defaults (default SG / NACL / route table) are created by
  # AWS untagged; the vpc module adopts and tags them as this env.
  statement {
    sid       = "Ec2TagAsThisEnv"
    actions   = ["ec2:CreateTags"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = [each.key]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = local.allowed_tag_keys
    }
  }

  statement {
    sid       = "Ec2ModifyOwnEnvironment"
    actions   = concat(local.ec2_create_actions, local.ec2_modify_actions)
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Environment"
      values   = [each.key]
    }
  }

  statement {
    sid       = "LoadBalancer"
    actions   = ["elasticloadbalancing:*"]
    resources = ["${local.arn}:elasticloadbalancing:*:${local.acct}:*/${var.project}-${each.key}*"]
  }

  statement {
    sid     = "Waf"
    actions = ["wafv2:*"]
    resources = [
      "${local.arn}:wafv2:*:${local.acct}:regional/webacl/${var.project}-${each.key}*",
      "${local.arn}:wafv2:*:${local.acct}:regional/managedruleset/*",
      "${local.arn}:elasticloadbalancing:*:${local.acct}:loadbalancer/app/${var.project}-${each.key}*",
    ]
  }

  statement {
    sid       = "Ecs"
    actions   = ["ecs:*"]
    resources = ["${local.arn}:ecs:*:${local.acct}:*${var.project}-${each.key}*"]
  }

  # (De)RegisterTaskDefinition and the autoscaling APIs have no
  # resource-level permissions.
  statement {
    sid = "TaskDefinitionsAndScaling"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DeregisterTaskDefinition",
      "application-autoscaling:RegisterScalableTarget",
      "application-autoscaling:DeregisterScalableTarget",
      "application-autoscaling:PutScalingPolicy",
      "application-autoscaling:DeleteScalingPolicy",
      "application-autoscaling:TagResource",
      "logs:CreateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:GetLogDelivery",
      "logs:ListLogDeliveries",
      "logs:UpdateLogDelivery",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:PutQueryDefinition",
      "logs:DeleteQueryDefinition",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = local.regions
    }
  }

  statement {
    sid       = "Ecr"
    actions   = ["ecr:*"]
    resources = ["${local.arn}:ecr:*:${local.acct}:repository/${var.project}-${each.key}*/*"]
  }
}

# Policy 4/5: data stores, messaging, secrets, keys, logs, alarms.
data "aws_iam_policy_document" "apply_data" {
  for_each = var.environments

  #checkov:skip=CKV_AWS_356:kms:CreateKey has no resource; it is tag- and region-conditioned
  #checkov:skip=CKV_AWS_111:Writes are name-scoped or tag-conditioned to the environment
  #checkov:skip=CKV_AWS_109:KMS key policy writes are limited to keys tagged with this environment

  statement {
    sid     = "Rds"
    actions = ["rds:*"]
    resources = [
      "${local.arn}:rds:*:${local.acct}:*:${var.project}-${each.key}*",
      "${local.arn}:rds:*:${local.acct}:og:default*",
      "${local.arn}:rds:*:${local.acct}:auto-backup:*",
    ]
  }

  statement {
    sid     = "ElastiCache"
    actions = ["elasticache:*"]
    resources = [
      "${local.arn}:elasticache:*:${local.acct}:*:${var.project}-${each.key}*",
      "${local.arn}:elasticache:*:${local.acct}:parametergroup:default.*",
    ]
  }

  statement {
    sid = "SqsManagement"
    actions = [
      "sqs:CreateQueue",
      "sqs:DeleteQueue",
      "sqs:SetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:TagQueue",
      "sqs:UntagQueue",
    ]
    resources = ["${local.arn}:sqs:*:${local.acct}:${var.project}-${each.key}-*"]
  }

  # Bucket-level ARNs only: configuration yes, tenant OBJECTS no.
  statement {
    sid       = "S3BucketManagement"
    actions   = ["s3:CreateBucket", "s3:DeleteBucket", "s3:Get*", "s3:Put*", "s3:DeleteBucket*", "s3:List*"]
    resources = ["${local.arn}:s3:::${var.project}-${each.key}-*"]
  }

  # Own secrets prefix only (refresh reads secret_version values).
  statement {
    sid       = "OwnSecrets"
    actions   = ["secretsmanager:*"]
    resources = ["${local.arn}:secretsmanager:*:${local.acct}:secret:${var.project}-${each.key}*/*"]
  }

  # manage_master_user_password: RDS creates rds!db-* on our behalf
  # using the caller's permissions.
  statement {
    sid       = "RdsManagedMasterSecret"
    actions   = ["secretsmanager:CreateSecret", "secretsmanager:TagResource"]
    resources = ["${local.arn}:secretsmanager:*:${local.acct}:secret:rds!*"]
  }

  statement {
    sid       = "CreateKeysTaggedForThisEnv"
    actions   = ["kms:CreateKey", "kms:TagResource"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/Environment"
      values   = [each.key]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = local.regions
    }
  }

  # ABAC: keys are only manageable/usable when tagged with this env
  # (default_tags guarantees the tag on every key we create).
  statement {
    sid = "ManageAndUseOwnKeys"
    actions = [
      "kms:PutKeyPolicy",
      "kms:EnableKeyRotation",
      "kms:DisableKeyRotation",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
      "kms:UpdateKeyDescription",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:CreateGrant",
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:UpdateAlias",
    ]
    resources = ["${local.arn}:kms:*:${local.acct}:key/*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Environment"
      values   = [each.key]
    }
  }

  statement {
    sid       = "OwnAliases"
    actions   = ["kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias"]
    resources = ["${local.arn}:kms:*:${local.acct}:alias/${var.project}-${each.key}-*"]
  }

  # Tenant directory global table (+ replicas, streams) of this tier.
  statement {
    sid     = "OwnDynamoDbTables"
    actions = ["dynamodb:*"]
    resources = [
      "${local.arn}:dynamodb:*:${local.acct}:table/${var.project}-${each.key}-*",
      "${local.arn}:dynamodb:*:${local.acct}:table/${var.project}-${each.key}-*/*",
    ]
  }

  statement {
    sid       = "OwnLogGroups"
    actions   = ["logs:*"]
    resources = ["${local.arn}:logs:*:${local.acct}:log-group:*${var.project}-${each.key}*"]
  }

  statement {
    sid       = "OwnAlarms"
    actions   = ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms", "cloudwatch:TagResource", "cloudwatch:UntagResource"]
    resources = ["${local.arn}:cloudwatch:*:${local.acct}:alarm:${var.project}-${each.key}-*"]
  }

  statement {
    sid = "OwnTopics"
    actions = [
      "sns:CreateTopic",
      "sns:DeleteTopic",
      "sns:SetTopicAttributes",
      "sns:Subscribe",
      "sns:Unsubscribe",
      "sns:SetSubscriptionAttributes",
      "sns:TagResource",
      "sns:UntagResource",
    ]
    resources = ["${local.arn}:sns:*:${local.acct}:${var.project}-${each.key}-*"]
  }
}

locals {
  apply_policy_parts = {
    for pair in setproduct(var.environments, ["iam-state", "read", "compute", "data", "dns"]) :
    "${pair[0]}/${pair[1]}" => { env = pair[0], part = pair[1] }
  }

  apply_policy_json = {
    for k, v in local.apply_policy_parts : k => (
      v.part == "iam-state" ? data.aws_iam_policy_document.apply_iam_state[v.env].json :
      v.part == "read" ? data.aws_iam_policy_document.apply_read[v.env].json :
      v.part == "compute" ? data.aws_iam_policy_document.apply_compute[v.env].json :
      v.part == "data" ? data.aws_iam_policy_document.apply_data[v.env].json :
      data.aws_iam_policy_document.apply_dns[v.env].json
    )
  }
}

# Policy 5/5: Route 53 (global stack edge routing). Record changes are
# limited to this tier's API names: api.<zone> / *.api.<zone> for prod,
# api.<env>.<zone> / *.api.<env>.<zone> otherwise.
data "aws_iam_policy_document" "apply_dns" {
  for_each = var.environments

  #checkov:skip=CKV_AWS_356:Route 53 health-check and change APIs lack resource-level permissions
  #checkov:skip=CKV_AWS_111:Record writes are limited by normalized record name to this tier

  statement {
    sid       = "ReadZones"
    actions   = ["route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:GetChange", "route53:ListTagsForResource"]
    resources = ["${local.arn}:route53:::hostedzone/*", "${local.arn}:route53:::change/*"]
  }

  statement {
    sid       = "ChangeOwnApiRecords"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["${local.arn}:route53:::hostedzone/*"]

    condition {
      test     = "ForAllValues:StringLike"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values = (
        each.key == "prod"
        ? ["api.${var.dns_zone_name}", "*.api.${var.dns_zone_name}"]
        : ["api.${each.key}.${var.dns_zone_name}", "*.api.${each.key}.${var.dns_zone_name}"]
      )
    }
  }

  statement {
    sid = "HealthChecks"
    actions = [
      "route53:CreateHealthCheck",
      "route53:UpdateHealthCheck",
      "route53:DeleteHealthCheck",
      "route53:GetHealthCheck",
      "route53:ChangeTagsForResource",
    ]
    resources = ["*"]
  }
}

# Customer-managed policies (6 KiB each) rather than one inline policy:
# the full set exceeds the 10 KiB per-role inline limit.
resource "aws_iam_policy" "apply" {
  for_each = local.apply_policy_parts

  name        = "${local.ci_prefix}-apply-${each.value.env}-${each.value.part}"
  description = "terraform apply (${each.value.part}) for ${each.value.env}"
  policy      = local.apply_policy_json[each.key]
}

resource "aws_iam_role_policy_attachment" "apply" {
  for_each = local.apply_policy_parts

  role       = aws_iam_role.apply[each.value.env].name
  policy_arn = aws_iam_policy.apply[each.key].arn
}
