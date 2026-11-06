#!/usr/bin/env bash
# LocalStack "ready" init hook: creates the AWS resources the app talks to.
#
# Names, DLQ redrive (5 receives) and visibility timeout match the Terraform
# `local` composition (infra/terraform/environments/local, name prefix
# `lending-local`), so `make tf-local` and this hook produce the same
# shapes. Set LOCALSTACK_INIT_RESOURCES=false to skip this hook and let
# Terraform create the resources instead (that is what `make tf-local` does).
#
# Idempotent: create-queue returns the existing queue when attributes match;
# the bucket is only created when absent.
set -euo pipefail

if [[ "${LOCALSTACK_INIT_RESOURCES:-true}" != "true" ]]; then
  echo "[init] LOCALSTACK_INIT_RESOURCES=false: skipping resource creation"
  exit 0
fi

region="${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION must be set}"
prefix="${RESOURCE_PREFIX:-lending-local}"
queue="${prefix}-domain-events"
dlq="${queue}-dlq"
bucket="${prefix}-branding"
directory_table="${prefix}-tenant-directory"

echo "[init] region=${region} queue=${queue} dlq=${dlq} bucket=${bucket} table=${directory_table}"

# Dead-letter queue first: the main queue's redrive policy references it.
# 14-day retention (the maximum) leaves time to triage poison messages.
dlq_url="$(awslocal sqs create-queue --region "${region}" \
  --queue-name "${dlq}" \
  --attributes MessageRetentionPeriod=1209600 \
  --query QueueUrl --output text)"
dlq_arn="$(awslocal sqs get-queue-attributes --region "${region}" \
  --queue-url "${dlq_url}" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)"

# Attributes go through a JSON file: RedrivePolicy is itself a JSON string,
# and nesting it inside a shell argument is quoting-error-prone.
attrs="$(mktemp)"
trap 'rm -f "${attrs}"' EXIT
cat >"${attrs}" <<JSON
{
  "VisibilityTimeout": "60",
  "MessageRetentionPeriod": "345600",
  "RedrivePolicy": "{\\"deadLetterTargetArn\\":\\"${dlq_arn}\\",\\"maxReceiveCount\\":\\"5\\"}"
}
JSON
awslocal sqs create-queue --region "${region}" \
  --queue-name "${queue}" \
  --attributes "file://${attrs}" >/dev/null

if ! awslocal s3api head-bucket --bucket "${bucket}" >/dev/null 2>&1; then
  awslocal s3 mb "s3://${bucket}" --region "${region}"
fi
# Block every form of public access, as in the cloud storage module.
awslocal s3api put-public-access-block --bucket "${bucket}" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Global tenant directory: slug -> home cell. One table shared by every
# local cell (in AWS: a DynamoDB global table replicated across regions).
if ! awslocal dynamodb describe-table --region "${region}" \
  --table-name "${directory_table}" >/dev/null 2>&1; then
  awslocal dynamodb create-table --region "${region}" \
    --table-name "${directory_table}" \
    --attribute-definitions AttributeName=slug,AttributeType=S \
    --key-schema AttributeName=slug,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  awslocal dynamodb wait table-exists --region "${region}" \
    --table-name "${directory_table}"
fi

echo "[init] resources ready"
