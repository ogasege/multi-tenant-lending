# syntax=docker/dockerfile:1.12
#
# Database migrations image: Flyway + this repo's SQL, nothing else. Run as a one-off task
# (ECS run-task / compose `migrate`) before the API and worker roll out (SPEC §12).
#
#   docker build -t tenmg-lending-migrations db
#   docker run --rm -e DATABASE_HOST=... -e DATABASE_NAME=... \
#     -e DATABASE_MIGRATOR_USER=... -e DATABASE_MIGRATOR_PASSWORD=... \
#     -e DATABASE_APP_PASSWORD=... -e DATABASE_WORKER_PASSWORD=... tenmg-lending-migrations
#
# Build context is db/ (see db/.dockerignore). The base image is pinned by tag AND
# digest: the tag documents intent, the digest makes the build reproducible. 11.20.3 is
# the newest Flyway 11 release. This is the ONLY place the Flyway version is pinned: the
# tests (test/setup/postgres.ts) and `npm run db:migrate` (scripts/db-migrate.sh) build
# and run this same image.
#
# Supply chain: the stock image ships drivers and plugins for ~30 databases plus Azure/GCP/
# AWS auth stacks, and most of the HIGH/CRITICAL CVEs in it live there. This image keeps
# only Flyway core, the commands we use and the PostgreSQL plugin, and replaces the
# PostgreSQL driver and the Jackson jars Flyway core needs with patched releases from
# Maven Central, each pinned by SHA-256. CI gates it with Trivy (HIGH,CRITICAL).
ARG FLYWAY_IMAGE=flyway/flyway:11.20.3-alpine@sha256:07f65a04ac518f3bf1c00a52dab46aa9649d931510860c6ac5363d6fb75e4c1b
# Build stage only (never shipped): the Flyway image has a JRE but no compiler.
# Temurin 21.0.13+9; --release 21 keeps the class runnable on the runtime JRE 21.
ARG JDK_IMAGE=eclipse-temurin:21-jdk-alpine@sha256:82801f9dcdcbad5a05082aba8c86d1da5b72ccb498e71318b1f91b5a477887b3

# ---------------------------------------------------------------------------
# tools: SCRAM-SHA-256 verifier generator used by docker-entrypoint.sh, so the
# runtime roles' plaintext passwords never reach Flyway or PostgreSQL.
# ---------------------------------------------------------------------------
FROM ${JDK_IMAGE} AS tools
COPY tools/ScramVerifier.java /src/
RUN javac --release 21 -Xlint:all -Werror -d /out /src/ScramVerifier.java

FROM ${FLYWAY_IMAGE}

ARG MAVEN=https://repo1.maven.org/maven2
ARG JACKSON=2.21.8
ARG PGJDBC=42.7.14

# Patched replacements, staged first and swapped in by the RUN below.
# hadolint's DL3020 ("use COPY") cannot tell that ${MAVEN}/... is a remote URL; ADD is required
# here to download with --checksum verification, which COPY cannot do.
# hadolint ignore=DL3020
ADD --chmod=0644 --checksum=sha256:73914527305a40cce504b0d3d90b23caf565136912d607ae8ae7c5895512332c \
    ${MAVEN}/org/postgresql/postgresql/${PGJDBC}/postgresql-${PGJDBC}.jar /opt/staging/drivers/
# hadolint ignore=DL3020
ADD --chmod=0644 --checksum=sha256:604ef7765013daf5cde192e40bc4c8412c4ca93f4aaf7bf8e9a62fad1e1026bb \
    ${MAVEN}/com/fasterxml/jackson/core/jackson-core/${JACKSON}/jackson-core-${JACKSON}.jar /opt/staging/lib/
# hadolint ignore=DL3020
ADD --chmod=0644 --checksum=sha256:ad77f2285717e2f34c319d988b7c85783a47d0b33f33a501d1fcbf196e61bbaa \
    ${MAVEN}/com/fasterxml/jackson/core/jackson-databind/${JACKSON}/jackson-databind-${JACKSON}.jar /opt/staging/lib/
# Since 2.20 jackson-annotations is versioned by minor only.
# hadolint ignore=DL3020
ADD --chmod=0644 --checksum=sha256:53ca085f4a150f703f49e1aabd935bd03b43e1ea3d55d135438292af22cef56b \
    ${MAVEN}/com/fasterxml/jackson/core/jackson-annotations/2.21/jackson-annotations-2.21.jar /opt/staging/lib/
# hadolint ignore=DL3020
ADD --chmod=0644 --checksum=sha256:f6f048dcbd7482e873d00af0a8361b2a9196e47c25c74e981885620edc703975 \
    ${MAVEN}/com/fasterxml/jackson/dataformat/jackson-dataformat-toml/${JACKSON}/jackson-dataformat-toml-${JACKSON}.jar /opt/staging/lib/
# hadolint ignore=DL3020
ADD --chmod=0644 --checksum=sha256:0285fed528d3a7f73aeef5c4f5c3380810936c62094a56afe6c604657c682d84 \
    ${MAVEN}/com/fasterxml/jackson/dataformat/jackson-dataformat-xml/${JACKSON}/jackson-dataformat-xml-${JACKSON}.jar /opt/staging/lib/
# hadolint ignore=DL3020
ADD --chmod=0644 --checksum=sha256:63a0854504aa90ed8f34f891aaa5259f9bd622bac115323559a38abdc1e81632 \
    ${MAVEN}/com/fasterxml/jackson/datatype/jackson-datatype-jsr310/${JACKSON}/jackson-datatype-jsr310-${JACKSON}.jar /opt/staging/lib/

# Amazon RDS CA bundle for DATABASE_SSL=true (sslmode=verify-full). Pinned by checksum:
# AWS re-issuing the bundle fails the build loudly instead of silently changing trust.
# hadolint ignore=DL3020
ADD --chmod=0644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /flyway/certs/rds-global-bundle.pem

# 1. OS: pick up Alpine security fixes released after the base image was built.
# 2. Drivers: PostgreSQL only (patched); every other JDBC driver and cloud bundle goes.
# 3. Flyway plugins: keep-list (core, CLI, the verbs we run, PostgreSQL). New plugins in a
#    future base image are dropped by default rather than silently shipped.
# 4. Azure AD / Netty auth stacks: unused (password auth to PostgreSQL only).
# 5. Jackson: swap the vulnerable 2.19 jars for the patched release.
# The final `flyway --version` proves the trimmed classpath still starts.
RUN set -eux; \
    apk upgrade --no-cache; \
    rm -rf /flyway/drivers/* /flyway/lib/aad /flyway/lib/netty; \
    mv /opt/staging/drivers/*.jar /flyway/drivers/; \
    find /flyway/lib/flyway -name '*.jar' \
      ! -name 'flyway-core-*' \
      ! -name 'flyway-commandline-*' \
      ! -name 'flyway-database-postgresql-*' \
      ! -name 'flyway-nc-core-*' \
      ! -name 'flyway-nc-callbacks-*' \
      ! -name 'flyway-nc-scanners-*' \
      ! -name 'flyway-reports-*' \
      ! -name 'flyway-verb-*' \
      ! -name 'flyway-command-test-connection-*' \
      -delete; \
    rm -f /flyway/lib/jackson-*.jar /flyway/lib/msal4j-*.jar /flyway/lib/oauth2-oidc-sdk-*.jar \
          /flyway/lib/nimbus-jose-jwt-*.jar /flyway/lib/lang-tag-*.jar \
          /flyway/lib/content-type-*.jar /flyway/lib/json-smart-*.jar \
          /flyway/lib/accessors-smart-*.jar /flyway/lib/jcip-annotations-*.jar; \
    mv /opt/staging/lib/*.jar /flyway/lib/; \
    rm -rf /opt/staging; \
    adduser -D -H -u 10001 migrator; \
    REDGATE_DISABLE_TELEMETRY=true flyway --version

COPY --from=tools --chmod=0644 /out/ScramVerifier.class /flyway/tools/

# Read-only SQL and config, owned by root; Flyway runs as an unprivileged user.
COPY --chmod=0755 docker-entrypoint.sh /flyway/project/db/docker-entrypoint.sh
COPY flyway.toml /flyway/project/db/flyway.toml
COPY migrations/ /flyway/project/db/migrations/
COPY callbacks/ /flyway/project/db/callbacks/

USER 10001:10001

WORKDIR /flyway/project
ENTRYPOINT ["/flyway/project/db/docker-entrypoint.sh"]
CMD ["migrate"]
