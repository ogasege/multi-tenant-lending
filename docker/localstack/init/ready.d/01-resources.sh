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
# The EU cell (compose profile `two-cells`) gets its OWN domain-events queue
# and DLQ, as each cell does in AWS (one messaging module per cell). A
# shared queue would let worker-eu receive Lagos events it cannot find in
# its own outbox, delaying delivery and pushing messages towards the DLQ.
# Created unconditionally: cheap, and the profile can be enabled later
# without recreating LocalStack.
eu_prefix="${EU_RESOURCE_PREFIX:-${prefix}-eu}"
bucket="${prefix}-branding"
directory_table="${prefix}-tenant-directory"

echo "[init] region=${region} bucket=${bucket} table=${directory_table}"

attrs="$(mktemp)"
trap 'rm -f "${attrs}"' EXIT

# create_domain_events_queue <cell name prefix>
# Creates "<prefix>-domain-events" and its DLQ "<prefix>-domain-events-dlq"
# with the same settings as the Terraform messaging module.
create_domain_events_queue() {
  local queue="$1-domain-events"
  local dlq="${queue}-dlq"
  local dlq_url dlq_arn
  echo "[init] queue=${queue} dlq=${dlq}"

  # Dead-letter queue first: the main queue's redrive policy references it.
  # 14-day retention (the maximum) leaves time to triage poison messages.
  dlq_url="$(awslocal sqs create-queue --region "${region}" \
    --queue-name "${dlq}" \
    --attributes MessageRetentionPeriod=1209600 \
    --query QueueUrl --output text)"
  dlq_arn="$(awslocal sqs get-queue-attributes --region "${region}" \
    --queue-url "${dlq_url}" --attribute-names QueueArn \
    --query Attributes.QueueArn --output text)"

  # Attributes go through a JSON file: RedrivePolicy is itself a JSON
  # string, and nesting it inside a shell argument is quoting-error-prone.
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
}

create_domain_events_queue "${prefix}"
create_domain_events_queue "${eu_prefix}"

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
