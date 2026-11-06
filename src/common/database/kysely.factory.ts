import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { configurePgTypes } from './pg-types';
import type { Database } from './schema';

export interface DbConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  poolMax: number;
  applicationName: string;
}

export function createKysely(opts: DbConnectionOptions): Kysely<Database> {
  configurePgTypes();
  const pool = new pg.Pool({
    host: opts.host,
    port: opts.port,
    database: opts.database,
    user: opts.user,
    password: opts.password,
    // RDS enforces TLS (rds.force_ssl=1). Certificate verification uses the RDS CA bundle
    // baked into the image via NODE_EXTRA_CA_CERTS.
    ssl: opts.ssl ? { rejectUnauthorized: true } : false,
    max: opts.poolMax,
    application_name: opts.applicationName,
    // Fail fast instead of piling up requests when the database is unhealthy.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    // Guard rails against runaway queries holding row locks.
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
