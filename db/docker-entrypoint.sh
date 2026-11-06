#!/bin/sh
# Entrypoint of the migrations image (db/Dockerfile) and of `npm run db:migrate`.
#
# Maps the runtime contract (docs/design/SPEC.md §12) onto Flyway's environment variables,
# so compose, ECS and the tests pass the same DATABASE_* variables they always have:
#   DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_SSL  -> FLYWAY_URL
#   DATABASE_MIGRATOR_USER / DATABASE_MIGRATOR_PASSWORD        -> FLYWAY_USER / FLYWAY_PASSWORD
#   DATABASE_APP_PASSWORD / DATABASE_WORKER_PASSWORD           -> SCRAM-SHA-256 verifiers
#                                                                 in FLYWAY_PLACEHOLDERS_*
# Secrets travel only in the environment, never in argv, and the runtime roles' plaintext
# passwords never reach Flyway or PostgreSQL (see db/callbacks/beforeMigrate.sql).
# Arguments are passed to Flyway (default: `migrate`).
set -eu

require() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    echo "[db-migrate] $1 is required" >&2
    exit 64
  fi
}

for name in DATABASE_HOST DATABASE_NAME DATABASE_MIGRATOR_USER DATABASE_MIGRATOR_PASSWORD \
  DATABASE_APP_PASSWORD DATABASE_WORKER_PASSWORD; do
  require "$name"
done

# Verifiers, not passwords, go to Flyway: ScramVerifier reads the variables by NAME from
# the environment and prints one verifier per line. It rejects empty or non-printable-ASCII
# values (exit 64). Only lines in verifier format are kept (the JVM may print warnings).
verifiers="$(java -cp /flyway/tools ScramVerifier DATABASE_APP_PASSWORD DATABASE_WORKER_PASSWORD)"
app_scram="$(printf '%s\n' "$verifiers" | grep '^SCRAM-SHA-256\$' | sed -n 1p)"
worker_scram="$(printf '%s\n' "$verifiers" | grep '^SCRAM-SHA-256\$' | sed -n 2p)"
if [ -z "$app_scram" ] || [ -z "$worker_scram" ]; then
  echo "[db-migrate] could not compute SCRAM-SHA-256 verifiers" >&2
  exit 70
fi

if [ "${DATABASE_SSL:-false}" = "true" ]; then
  # verify-full: encrypted AND the server certificate must match the host. The CA bundle
  # path is overridable (RDS: the regional bundle baked into the image).
  ssl="sslmode=verify-full&sslrootcert=${DATABASE_SSL_ROOT_CERT:-/flyway/certs/rds-global-bundle.pem}"
else
  ssl="sslmode=disable"
fi

export FLYWAY_URL="jdbc:postgresql://${DATABASE_HOST}:${DATABASE_PORT:-5432}/${DATABASE_NAME}?${ssl}"
export FLYWAY_USER="$DATABASE_MIGRATOR_USER"
export FLYWAY_PASSWORD="$DATABASE_MIGRATOR_PASSWORD"
export FLYWAY_PLACEHOLDERS_APPPASSWORDSCRAM="$app_scram"
export FLYWAY_PLACEHOLDERS_WORKERPASSWORDSCRAM="$worker_scram"
# Flyway does not need the plaintext: keep it out of the JVM's environment.
unset DATABASE_APP_PASSWORD DATABASE_WORKER_PASSWORD verifiers
# Flyway (Redgate) phones home by default; a migration task has no business doing so.
export REDGATE_DISABLE_TELEMETRY=true

cd "$(dirname "$0")/.."
if [ "$#" -eq 0 ]; then set -- migrate; fi
exec flyway -configFiles=db/flyway.toml "$@"
