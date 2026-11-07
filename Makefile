# Developer entry points. `make help` lists every target.
#
# Two ways to test locally, both with real infrastructure in containers:
#   make test         Vitest on the host; Testcontainers starts throwaway
#                     Postgres / Redis / LocalStack per run (needs Node 24).
#   make test-docker  The same suite inside a container that drives the host
#                     Docker daemon through its socket (needs Docker only).
# And one way to run the whole system:
#   make up           Builds the image and starts postgres, redis, localstack,
#                     runs migrations, starts the API and worker; waits
#                     until healthy.

SHELL := /bin/bash
# Honoured by GNU make >= 3.82; macOS ships 3.81, where recipes stay simple enough not to need it.
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

COMPOSE ?= docker compose
# Extra compose profiles, e.g. `make up PROFILES=two-cells`.
PROFILES ?=
PROFILE_FLAGS := $(foreach p,$(PROFILES),--profile $(p))

TEST_IMAGE ?= tenmg-lending-core:test
# Host Docker socket as seen by the daemon. /var/run/docker.sock is right for
# Linux, Docker Desktop (macOS/Windows) and OrbStack.
DOCKER_SOCKET ?= /var/run/docker.sock
TF_LOCAL_DIR := infra/terraform/environments/local

# Host-side variants of the compose settings, for host processes (seed) that
# talk to the containers through their published loopback ports.
define host_env
set -a; source .env; set +a; \
export DATABASE_HOST=127.0.0.1 DATABASE_PORT="$${POSTGRES_HOST_PORT:-5432}" DATABASE_SSL=false \
  REDIS_URL="redis://:$${REDIS_PASSWORD}@127.0.0.1:$${REDIS_HOST_PORT:-6379}" \
  AWS_ENDPOINT_URL="http://127.0.0.1:$${LOCALSTACK_HOST_PORT:-4566}" \
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  SQS_DOMAIN_EVENTS_QUEUE_URL="$${SQS_DOMAIN_EVENTS_QUEUE_URL/localstack:4566/127.0.0.1:$${LOCALSTACK_HOST_PORT:-4566}}";
endef

##@ Local stack

.env: .env.example
	@if [[ -f .env ]]; then \
	  echo ".env is older than .env.example - review new variables (not overwritten)"; \
	  touch .env; \
	else \
	  cp .env.example .env; echo "created .env from .env.example (LOCAL ONLY values)"; \
	fi

.PHONY: build
build: .env ## Build the application image
	$(COMPOSE) build

.PHONY: up
up: .env ## Build, start the stack and wait until every service is healthy
	$(COMPOSE) $(PROFILE_FLAGS) up --build --detach --wait --wait-timeout 300
	@$(COMPOSE) $(PROFILE_FLAGS) ps
	@echo "API ready: http://localhost:$$(grep -E '^API_HOST_PORT=' .env | cut -d= -f2 || echo 3000)/health/ready"

.PHONY: down
down: ## Stop and remove containers (keeps volumes)
	$(COMPOSE) --profile '*' down --remove-orphans

.PHONY: clean
clean: ## Stop everything and delete volumes (database and LocalStack data)
	$(COMPOSE) --profile '*' down --volumes --remove-orphans

.PHONY: logs
logs: ## Follow logs (all services, or SERVICE=api)
	$(COMPOSE) --profile '*' logs --follow --tail 200 $(SERVICE)

.PHONY: ps
ps: ## Show service status
	$(COMPOSE) --profile '*' ps --all

.PHONY: migrate
migrate: .env ## Apply database migrations (Flyway one-shot container, schema owner role)
	$(COMPOSE) run --rm --build migrate

.PHONY: migrate-info
migrate-info: .env ## Show Flyway migration status (applied / pending)
	$(COMPOSE) run --rm --build migrate info

# EU-cell overrides for host_env (profile two-cells).
define eu_env
export DATABASE_NAME="$${EU_DATABASE_NAME:-lending_eu}" \
  CELL_REGION="$${EU_CELL_REGION:-eu-west-3}" \
  CELL_API_BASE_URL="$${EU_CELL_API_BASE_URL:-http://localhost:3001}" \
  REDIS_URL="$${REDIS_URL}/1"; \
eu_queue="$${EU_SQS_DOMAIN_EVENTS_QUEUE_URL:-http://localstack:4566/000000000000/lending-local-eu-domain-events}"; \
export SQS_DOMAIN_EVENTS_QUEUE_URL="$${eu_queue/localstack:4566/127.0.0.1:$${LOCALSTACK_HOST_PORT:-4566}}";
endef

.PHONY: seed
seed: .env ## Seed demo lenders into the Lagos cell (and the EU cell if two-cells is running)
	@echo "== seeding Lagos cell"
	@$(host_env) npm run seed
	@if [[ -n "$$($(COMPOSE) --profile two-cells ps --status running --quiet api-eu 2>/dev/null)" ]]; then \
	  $(MAKE) --no-print-directory seed-eu; \
	fi

.PHONY: seed-eu
seed-eu: .env ## Seed demo lenders into the EU cell (profile two-cells)
	@echo "== seeding EU cell"
	@$(host_env) $(eu_env) npm run seed

.PHONY: seed-all
seed-all: .env ## Seed both cells (Lagos + EU)
	@echo "== seeding Lagos cell"
	@$(host_env) npm run seed
	@$(MAKE) --no-print-directory seed-eu

.PHONY: tf-local
tf-local: .env ## Apply the Terraform `local` composition to the compose LocalStack
	@if [[ ! -d "$(TF_LOCAL_DIR)" ]]; then echo "$(TF_LOCAL_DIR) not found - nothing to do"; exit 0; fi
	@if ! command -v tflocal >/dev/null; then \
	  echo "tflocal not found. Install it with: pipx install terraform-local"; exit 1; \
	fi
	@# Recreate LocalStack with the extra services Terraform manages and with
	@# the init hook disabled, so Terraform (not the hook) owns the resources.
	LOCALSTACK_SERVICES=s3,sqs,dynamodb,kms,secretsmanager LOCALSTACK_INIT_RESOURCES=false \
	  $(COMPOSE) up --detach --force-recreate --wait localstack
	set -a; source .env; set +a; \
	  export AWS_ENDPOINT_URL="http://localhost:$${LOCALSTACK_HOST_PORT:-4566}"; \
	  cd $(TF_LOCAL_DIR) && tflocal init -input=false && \
	  tflocal apply -input=false -auto-approve -var "aws_region=$${AWS_REGION}"
	@echo "NB: a later 'make up' recreates LocalStack with the init hook (Terraform state then refers to gone resources)."

# A Lagos (af-south-1) lender from the seed catalogue (src/cli/seed-lenders.ts).
DEMO_SLUG ?= eko-medicredit
DEMO_LOGIN_BODY = {"institutionSlug":"$(DEMO_SLUG)","email":"demo@example.com","password":"not-a-real-password"}

.PHONY: demo-cells
demo-cells: .env ## Two cells (Lagos :3000, EU :3001): seed both, show an EU login 307-redirected to Lagos
	$(COMPOSE) --profile two-cells up --build --detach --wait --wait-timeout 300
	@$(MAKE) --no-print-directory seed-all
	@echo "Tenant directory entries:"
	@$(COMPOSE) exec -T localstack sh -c 'awslocal dynamodb scan --region "$$AWS_DEFAULT_REGION" \
	  --table-name lending-local-tenant-directory --query Items --output json' || true
	@echo "POST EU cell /v1/auth/login for '$(DEMO_SLUG)' (expect 307 + Location on the Lagos cell):"
	@headers="$$(curl --silent --show-error --output /dev/null --dump-header - --request POST \
	  --header 'Content-Type: application/json' --data '$(DEMO_LOGIN_BODY)' \
	  "http://localhost:$$(grep -E '^EU_API_HOST_PORT=' .env | cut -d= -f2)/v1/auth/login")"; \
	  printf '%s\n' "$$headers" | grep -Ei '^(HTTP/|location:|x-tenant-cell:)'; \
	  printf '%s\n' "$$headers" | grep -q '^HTTP/[0-9.]* 307' || { echo "expected 307" >&2; exit 1; }
	@echo "Per-cell SQS isolation:"
	@COMPOSE='$(COMPOSE)' scripts/verify-cell-queues.sh

.PHONY: verify-cell-queues
verify-cell-queues: ## Check each cell uses its own SQS queue + DLQ and consumed no other cell's events
	@COMPOSE='$(COMPOSE)' scripts/verify-cell-queues.sh

##@ Tests (host, Testcontainers)

.PHONY: test
test: ## Run every Vitest project (unit, db, e2e)
	npm test

.PHONY: test-unit
test-unit: ## Unit tests only (no Docker needed)
	npm run test:unit

.PHONY: test-db
test-db: ## Database tests (RLS, ledger, audit) on Testcontainers Postgres
	npm run test:db

.PHONY: test-e2e
test-e2e: ## HTTP end-to-end tests on Testcontainers Postgres + Redis + LocalStack
	npm run test:e2e

.PHONY: coverage
coverage: ## All tests with the coverage gate (report in coverage/)
	npm run test:cov

.PHONY: test-docker
test-docker: ## Run the full suite inside a container (needs Docker only, no Node)
	docker build --target test --tag $(TEST_IMAGE) .
	@# Testcontainers "Docker wormhole" (Docker-out-of-Docker) settings:
	@#  - the host socket is mounted, so sibling containers start on the host
	@#    daemon (also used by Ryuk, which cleans them up afterwards);
	@#  - their ports are published on the host, so the test container reaches
	@#    them via host.docker.internal (built in on Docker Desktop/OrbStack;
	@#    --add-host maps it to the bridge gateway on Linux).
	docker run --rm --tty=$$([[ -t 1 ]] && echo true || echo false) \
	  --volume "$(DOCKER_SOCKET):/var/run/docker.sock" \
	  --add-host host.docker.internal:host-gateway \
	  --env TESTCONTAINERS_HOST_OVERRIDE=host.docker.internal \
	  --env TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock \
	  --env LOCALSTACK_AUTH_TOKEN \
	  $(TEST_IMAGE) $(if $(PROJECT),npx vitest run --project $(PROJECT),)

##@ Code quality

.PHONY: lint
lint: ## ESLint
	npm run lint

.PHONY: typecheck
typecheck: ## TypeScript type check
	npm run typecheck

.PHONY: format
format: ## Format the code base with Prettier (writes files)
	npm run format

.PHONY: format-check
format-check: ## Check formatting without writing
	npm run format:check

.PHONY: check
check: lint typecheck test-unit ## Fast pre-push gate: lint + typecheck + unit tests

.PHONY: openapi
openapi: ## Export the OpenAPI document (openapi/openapi.json)
	npm run openapi:export

.PHONY: openapi-check
openapi-check: ## Fail if the committed OpenAPI document is out of date
	npm run openapi:check

.PHONY: hadolint
hadolint: ## Lint the Dockerfile with hadolint (via Docker)
	docker run --rm -i hadolint/hadolint:v2.14.0@sha256:27086352fd5e1907ea2b934eb1023f217c5ae087992eb59fde121dce9c9ff21e < Dockerfile

##@ Help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN { FS = ":.*## " } \
	  /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5); next } \
	  /^[a-zA-Z0-9_-]+:.*## / { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
