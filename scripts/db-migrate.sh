#!/usr/bin/env bash
# `npm run db:migrate [-- <flyway command> ...]`: runs the migrations image against the
# database described by the DATABASE_* variables of the current environment (SPEC §12).
# Default command: `migrate`; e.g. `npm run db:migrate -- info` or `-- validate`.
#
# Typical local use against the compose Postgres (published on 127.0.0.1):
#   set -a; source .env; set +a; npm run db:migrate
#
# Only variable NAMES appear in the `docker run` argv (`-e NAME`); Docker copies the values
# from this process's environment, so no secret shows up in `ps` output.
set -euo pipefail

# The same image the migration task ships (db/Dockerfile: pinned Flyway base, trimmed and
# patched classpath, SQL baked in). Rebuilt on every run; layer caching makes that cheap.
IMAGE="${MIGRATIONS_IMAGE:-tenmg-lending-migrations:local}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export DATABASE_HOST="${DATABASE_HOST:-127.0.0.1}"
export DATABASE_PORT="${DATABASE_PORT:-${POSTGRES_HOST_PORT:-5432}}"

network_args=()
case "$DATABASE_HOST" in
  localhost | 127.0.0.1 | ::1)
    # Inside a container, loopback is the container itself. On Linux, share the host's
    # network namespace. Docker Desktop (macOS/Windows) runs containers in a VM where
    # --network host does not reach the host's loopback by default; it provides
    # host.docker.internal for exactly this.
    if [[ "$(docker info --format '{{.OperatingSystem}}' 2>/dev/null)" == *"Docker Desktop"* ]] ||
      [[ "$(uname -s)" != "Linux" ]]; then
      export DATABASE_HOST=host.docker.internal
    else
      network_args=(--network host)
    fi
    ;;
esac

DOCKER_BUILDKIT=1 docker build --quiet --tag "$IMAGE" "${repo_root}/db" >/dev/null

exec docker run --rm \
  "${network_args[@]+"${network_args[@]}"}" \
  -e DATABASE_HOST -e DATABASE_PORT -e DATABASE_NAME -e DATABASE_SSL \
  -e DATABASE_SSL_ROOT_CERT \
  -e DATABASE_MIGRATOR_USER -e DATABASE_MIGRATOR_PASSWORD \
  -e DATABASE_APP_PASSWORD -e DATABASE_WORKER_PASSWORD \
  "$IMAGE" "$@"
