#!/usr/bin/env bash
# `make verify-cell-queues` (also run by `make demo-cells`): checks that the
# two local cells (compose profile `two-cells`) are isolated on SQS, as they
# are in AWS where each cell has its own messaging module.
#
#   1. Both domain-events queues exist in LocalStack, each with its own DLQ
#      and a redrive policy of maxReceiveCount 5.
#   2. The running Lagos containers (api, worker) and EU containers (api-eu,
#      worker-eu) are configured with their own cell's queue, and the two
#      URLs differ.
#   3. Neither worker has logged "domain event not found in its tenant
#      outbox" since it started: that line is what a worker prints when it
#      receives another cell's event, so its absence shows no cross-cell
#      consumption happened.
#
# Reads only container metadata, queue attributes and logs; changes nothing.
set -euo pipefail

compose="${COMPOSE:-docker compose}"
prefix="${RESOURCE_PREFIX:-lending-local}"
eu_prefix="${EU_RESOURCE_PREFIX:-${prefix}-eu}"
# Logged by src/modules/webhooks/worker/webhook-dispatcher.ts.
foreign_event_msg='domain event not found in its tenant outbox'

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# compose_cmd <args...>: word-split COMPOSE on purpose ("docker compose").
compose_cmd() {
  # shellcheck disable=SC2086
  ${compose} --profile two-cells "$@"
}

# check_queue <cell prefix>: queue + DLQ exist and redrive is 5 receives.
check_queue() {
  local queue="$1-domain-events"
  local dlq="${queue}-dlq"
  local url redrive
  if ! url="$(compose_cmd exec -T localstack sh -c \
    "awslocal sqs get-queue-url --region \"\$AWS_DEFAULT_REGION\" \
      --queue-name '${queue}' --query QueueUrl --output text" 2>/dev/null)"; then
    fail "queue ${queue} does not exist"
    return
  fi
  redrive="$(compose_cmd exec -T localstack sh -c \
    "awslocal sqs get-queue-attributes --region \"\$AWS_DEFAULT_REGION\" \
      --queue-url '${url}' --attribute-names RedrivePolicy \
      --query Attributes.RedrivePolicy --output text")"
  if [[ "${redrive}" != *":${dlq}\""* ]] ||
    ! grep -Eq '"maxReceiveCount": ?"?5"?' <<<"${redrive}"; then
    fail "queue ${queue}: unexpected redrive policy ${redrive}"
  else
    echo "ok: ${queue} -> ${dlq} (maxReceiveCount 5)"
  fi
}

# queue_url_of <service>: SQS_DOMAIN_EVENTS_QUEUE_URL of the running container.
queue_url_of() {
  local id
  id="$(compose_cmd ps --status running --quiet "$1")"
  if [[ -z "${id}" ]]; then
    echo ""
    return
  fi
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${id}" |
    sed -n 's/^SQS_DOMAIN_EVENTS_QUEUE_URL=//p'
}

# check_service <service> <expected queue name>
check_service() {
  local url
  url="$(queue_url_of "$1")"
  if [[ -z "${url}" ]]; then
    fail "service $1 is not running (start with: make up PROFILES=two-cells)"
  elif [[ "${url##*/}" != "$2" ]]; then
    fail "service $1 uses ${url}, expected queue $2"
  else
    echo "ok: $1 -> ${url}"
  fi
}

# check_no_foreign_events <worker service>
check_no_foreign_events() {
  local count
  count="$(compose_cmd logs --no-log-prefix "$1" 2>/dev/null |
    grep -c "${foreign_event_msg}" || true)"
  if [[ "${count}" -gt 0 ]]; then
    fail "$1 logged '${foreign_event_msg}' ${count} time(s): it consumed another cell's events"
  else
    echo "ok: $1 has received no other cell's events"
  fi
}

check_queue "${prefix}"
check_queue "${eu_prefix}"
check_service api "${prefix}-domain-events"
check_service worker "${prefix}-domain-events"
check_service api-eu "${eu_prefix}-domain-events"
check_service worker-eu "${eu_prefix}-domain-events"
check_no_foreign_events worker
check_no_foreign_events worker-eu

if [[ "${failures}" -gt 0 ]]; then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
echo "cell queues isolated"
