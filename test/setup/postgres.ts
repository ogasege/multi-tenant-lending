import path from 'node:path';
import type { Readable } from 'node:stream';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Network, type StartedNetwork, Wait } from 'testcontainers';
import pg from 'pg';

/** The repo's db/ directory: migrations, callbacks, flyway.toml, docker-entrypoint.sh. */
export const DB_DIR = path.resolve(__dirname, '../../db');

/** Local tag for the migrations image built from db/Dockerfile. */
export const MIGRATIONS_IMAGE = 'tenmg-lending-migrations:test';

let migrationsImage: Promise<string> | undefined;

/**
 * Builds db/Dockerfile (pinned Flyway base, trimmed and patched classpath) once per test
 * process, so the tests run the same artifact that ships, not the stock Flyway image.
 * BuildKit is required (`ADD --checksum`); layer caching makes rebuilds near-instant.
 */
export function buildMigrationsImage(): Promise<string> {
  migrationsImage ??= GenericContainer.fromDockerfile(DB_DIR)
    .withBuildkit()
    .build(MIGRATIONS_IMAGE, { deleteOnExit: false })
    .then(() => MIGRATIONS_IMAGE);
  return migrationsImage;
}

/** Network alias under which the Flyway container reaches Postgres. */
const PG_ALIAS = 'postgres';

export const TEST_DB = {
  name: 'lending',
  owner: 'lending_owner',
  ownerPassword: 'owner-pw-test',
  appPassword: 'app-pw-test',
  workerPassword: 'worker-pw-test',
} as const;

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  network: StartedNetwork;
  host: string;
  port: number;
  /** Stops Postgres and removes its network. */
  stop(): Promise<void>;
}

export interface FlywayRunOptions {
  /** Flyway command and arguments; defaults to `migrate`. */
  args?: string[];
  appPassword?: string;
  workerPassword?: string;
  /** Directory mounted as db/ (defaults to the repo's); tests pass edited copies. */
  dbDir?: string;
  /** Database to migrate; defaults to `TEST_DB.name`. */
  database?: string;
  /** Extra environment, applied last (tests use it to bypass the entrypoint's hashing). */
  env?: Record<string, string>;
  /** Replaces the image entrypoint (db/docker-entrypoint.sh). */
  entrypoint?: string[];
}

export interface FlywayRunResult {
  ok: boolean;
  logs: string;
}

/**
 * Runs the migrations image once against the test database, exactly as production does:
 * through db/docker-entrypoint.sh with the DATABASE_* contract, as the NON-superuser owner.
 * The db/ directory baked into the image is overlaid with `dbDir` (default: the repo's),
 * so tests can run edited copies. Resolves with the container's combined output; `ok` is
 * true iff it exited with code 0.
 */
export async function runFlyway(
  pgc: TestPostgres,
  opts: FlywayRunOptions = {},
): Promise<FlywayRunResult> {
  let logs = '';
  let logsDone: Promise<void> = Promise.resolve();
  const container = new GenericContainer(await buildMigrationsImage())
    .withNetwork(pgc.network)
    .withCopyDirectoriesToContainer([
      { source: opts.dbDir ?? DB_DIR, target: '/flyway/project/db' },
    ])
    // `sh <file>` rather than the file itself: copied files need not keep their exec bit.
    .withEntrypoint(opts.entrypoint ?? ['sh', '/flyway/project/db/docker-entrypoint.sh'])
    .withCommand(opts.args ?? ['migrate'])
    .withEnvironment({
      DATABASE_HOST: PG_ALIAS,
      DATABASE_PORT: '5432',
      DATABASE_NAME: opts.database ?? TEST_DB.name,
      DATABASE_SSL: 'false',
      DATABASE_MIGRATOR_USER: TEST_DB.owner,
      DATABASE_MIGRATOR_PASSWORD: TEST_DB.ownerPassword,
      DATABASE_APP_PASSWORD: opts.appPassword ?? TEST_DB.appPassword,
      DATABASE_WORKER_PASSWORD: opts.workerPassword ?? TEST_DB.workerPassword,
      ...opts.env,
    })
    .withLogConsumer((stream: Readable) => {
      logsDone = new Promise((resolve) => {
        stream.on('data', (chunk: Buffer | string) => {
          logs += chunk.toString();
        });
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', () => {
          resolve();
        });
      });
    })
    .withWaitStrategy(Wait.forOneShotStartup())
    .withStartupTimeout(120_000);

  let ok = true;
  try {
    const started = await container.start();
    await logsDone;
    await started.stop();
  } catch {
    ok = false;
    await logsDone;
  }
  return { ok, logs };
}

/** Runs `flyway migrate` and throws, with Flyway's output, unless it succeeds. */
export async function migrate(
  pgc: TestPostgres,
  opts: Omit<FlywayRunOptions, 'args'> = {},
): Promise<string> {
  const { ok, logs } = await runFlyway(pgc, opts);
  if (!ok) throw new Error(`flyway migrate failed:\n${logs}`);
  return logs;
}

/**
 * Starts Postgres 16 and applies the real migrations with Flyway as a NON-superuser owner,
 * mirroring Amazon RDS (where the master user is not a superuser). A superuser would
 * silently bypass Row-Level Security and hide isolation bugs.
 */
export async function startPostgres(): Promise<TestPostgres> {
  const network = await new Network().start();
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withNetwork(network)
    .withNetworkAliases(PG_ALIAS)
    .withDatabase('postgres')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(
    `CREATE ROLE ${TEST_DB.owner} LOGIN CREATEROLE PASSWORD '${TEST_DB.ownerPassword}'`,
  );
  await admin.query(`CREATE DATABASE ${TEST_DB.name} OWNER ${TEST_DB.owner}`);
  await admin.end();

  // Fresh databases grant CREATE on public to PUBLIC only before PG15; make ownership explicit.
  const asSuperOnDb = new pg.Client({
    host: container.getHost(),
    port: container.getPort(),
    database: TEST_DB.name,
    user: 'postgres',
    password: 'postgres',
  });
  await asSuperOnDb.connect();
  await asSuperOnDb.query(`ALTER SCHEMA public OWNER TO ${TEST_DB.owner}`);
  await asSuperOnDb.end();

  const pgc: TestPostgres = {
    container,
    network,
    host: container.getHost(),
    port: container.getPort(),
    async stop() {
      await container.stop();
      await network.stop();
    },
  };
  try {
    await migrate(pgc);
  } catch (err) {
    await pgc.stop();
    throw err;
  }
  return pgc;
}

/**
 * Creates another database in the same container, owned by the non-superuser owner, and
 * migrates it with Flyway exactly like the main one. Used to simulate a second cell (its
 * own Postgres) in multi-cell journeys. The runtime roles are cluster-wide and shared.
 */
export async function createMigratedDatabase(pgc: TestPostgres, name: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Invalid database name ${name}`);
  const admin = new pg.Client({ connectionString: pgc.container.getConnectionUri() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER ${TEST_DB.owner}`);
  } finally {
    await admin.end();
  }
  const asSuperOnDb = new pg.Client({
    host: pgc.host,
    port: pgc.port,
    database: name,
    user: 'postgres',
    password: 'postgres',
  });
  await asSuperOnDb.connect();
  try {
    await asSuperOnDb.query(`ALTER SCHEMA public OWNER TO ${TEST_DB.owner}`);
  } finally {
    await asSuperOnDb.end();
  }
  await migrate(pgc, { database: name });
}

export function clientFor(pgc: TestPostgres, role: 'app' | 'worker' | 'owner'): pg.Client {
  const credentials = {
    app: { user: 'lending_app', password: TEST_DB.appPassword },
    worker: { user: 'lending_worker', password: TEST_DB.workerPassword },
    owner: { user: TEST_DB.owner, password: TEST_DB.ownerPassword },
  }[role];
  return new pg.Client({ host: pgc.host, port: pgc.port, database: TEST_DB.name, ...credentials });
}
