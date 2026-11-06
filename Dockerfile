# syntax=docker/dockerfile:1.12
# One image, two processes (docs/design/SPEC.md §12):
#   API     CMD ["dist/main.js"]     (default)
#   worker  CMD ["dist/worker.js"]
# The orchestrator (docker-compose / ECS task definition) picks the command.
# Database migrations are NOT in this image: they ship as a separate Flyway
# image built from db/Dockerfile, so the app image carries no DDL and the
# migrator credentials never reach an app container.
#
# Base images are pinned by tag AND digest: the tag documents intent, the
# digest makes the build reproducible and immune to a re-pushed tag.
# Dependabot (docker ecosystem) proposes digest bumps weekly.
#
# Targets:
#   runtime (default) - distroless, non-root, production dependencies only
#   test              - full dev toolchain; used by `make test-docker`

ARG NODE_BUILD_IMAGE=node:24-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
# WHY distroless: no shell, no package manager, no curl - a much smaller
# attack surface and CVE count than node:24-alpine. Debian 13 (glibc)
# matches the build stage, so native addons (argon2) built or downloaded
# there load unchanged at runtime. Debian 13, not 12: the debian12
# distroless variant lagged on OpenSSL fixes (HIGH/CRITICAL libssl3 CVEs
# in Trivy as of 2026-11), the debian13 one scanned clean.
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba

# ---------------------------------------------------------------------------
# deps: every dependency (dev included), cached on the lockfile alone.
# ---------------------------------------------------------------------------
FROM ${NODE_BUILD_IMAGE} AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
# Cache mount keeps the npm cache out of the layer but warm across builds.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

# ---------------------------------------------------------------------------
# build: compile TypeScript, then drop dev dependencies in place.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# test: the whole repo with dev tooling, for running Vitest in a container
# against the host Docker daemon (Testcontainers). Never deployed.
# ---------------------------------------------------------------------------
FROM deps AS test
COPY . .
ENV NODE_ENV=test
# Runs as root on purpose: it must talk to the mounted host Docker socket,
# whose group id differs per host (Docker Desktop, Linux CI). This image is
# a throwaway test harness and is never pushed or deployed.
CMD ["npx", "vitest", "run"]

# ---------------------------------------------------------------------------
# runtime: what ships.
# ---------------------------------------------------------------------------
FROM ${NODE_RUNTIME_IMAGE} AS runtime
WORKDIR /app

# Amazon RDS CA bundle (public certificates, not a secret). The pg driver
# connects with `ssl: { rejectUnauthorized: true }`, and RDS server certs
# chain to Amazon's RDS CAs, which are not in Node's built-in store.
# NODE_EXTRA_CA_CERTS adds them to the default trust store at start-up.
# Pinned by checksum (same pin as db/Dockerfile): if AWS re-issues the
# bundle the build fails loudly instead of silently changing what we trust;
# update the hash deliberately in both Dockerfiles.
ADD --chown=nonroot:nonroot --chmod=0444 \
    --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /app/certs/rds-global-bundle.pem

COPY --from=build --chown=nonroot:nonroot /app/package.json ./package.json
COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_EXTRA_CA_CERTS=/app/certs/rds-global-bundle.pem

# Distroless :nonroot already runs as uid 65532; stated explicitly so the
# image is non-root even if the base changes and so scanners can see it.
USER nonroot

EXPOSE 3000

# No HEALTHCHECK instruction, deliberately:
#  - the same image runs the worker, which serves no HTTP, so an
#    image-level HTTP probe would mark it unhealthy;
#  - distroless has no curl/wget/shell.
# Health is probed by the orchestrator instead: the ALB target group and the
# ECS container healthCheck in AWS, and docker-compose locally using
#   /nodejs/bin/node -e "fetch('http://127.0.0.1:3000/health/ready')..."
#
# Node runs as PID 1 and handles SIGTERM itself (NestJS
# enableShutdownHooks). Zombie reaping comes from `init: true` in compose and
# `initProcessEnabled` in the ECS task definition.
# The base image's ENTRYPOINT is /nodejs/bin/node, so CMD is the script.
CMD ["dist/main.js"]
