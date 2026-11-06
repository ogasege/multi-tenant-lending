import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { runMigrations } from '@/common/database/migrate';

export const TEST_DB = {
  name: 'lending',
  owner: 'lending_owner',
  ownerPassword: 'owner-pw-test',
  appPassword: 'app-pw-test',
  workerPassword: 'worker-pw-test',
} as const;

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  host: string;
  port: number;
}

/**
 * Starts Postgres 16 and applies the real migrations as a NON-superuser owner, mirroring
 * Amazon RDS (where the master user is not a superuser). A superuser would silently bypass
 * Row-Level Security and hide isolation bugs.
 */
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
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

  await runMigrations({
    connection: {
      host: container.getHost(),
      port: container.getPort(),
      database: TEST_DB.name,
      user: TEST_DB.owner,
      password: TEST_DB.ownerPassword,
    },
    appPassword: TEST_DB.appPassword,
    workerPassword: TEST_DB.workerPassword,
    dbDir: path.resolve(__dirname, '../../db'),
  });

  return { container, host: container.getHost(), port: container.getPort() };
}

export function clientFor(pgc: TestPostgres, role: 'app' | 'worker' | 'owner'): pg.Client {
  const credentials = {
    app: { user: 'lending_app', password: TEST_DB.appPassword },
    worker: { user: 'lending_worker', password: TEST_DB.workerPassword },
    owner: { user: TEST_DB.owner, password: TEST_DB.ownerPassword },
  }[role];
  return new pg.Client({ host: pgc.host, port: pgc.port, database: TEST_DB.name, ...credentials });
}
