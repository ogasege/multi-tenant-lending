/* Forward-only SQL migration runner. Runs as the schema owner (one-off ECS task / `make migrate`). */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import pg from 'pg';

export interface MigrateOptions {
  connection: pg.ClientConfig;
  appPassword: string;
  workerPassword: string;
  dbDir?: string;
  log?: (msg: string) => void;
}

/** Arbitrary constant: serialises concurrent migration runs (e.g. two deploys racing). */
const MIGRATION_LOCK_KEY = 72_310_001;

export async function runMigrations(opts: MigrateOptions): Promise<string[]> {
  const log = opts.log ?? (() => undefined);
  const dbDir = opts.dbDir ?? path.resolve(process.env.DB_DIR ?? 'db');
  const client = new pg.Client(opts.connection);
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    // 1. Login roles (idempotent). Passwords travel as transaction-local settings, never as SQL text.
    const rolesSql = await readFile(path.join(dbDir, 'bootstrap', 'roles.sql'), 'utf8');
    await inTransaction(client, async () => {
      await client.query(
        `SELECT set_config('bootstrap.app_password', $1, true),
                set_config('bootstrap.worker_password', $2, true)`,
        [opts.appPassword, opts.workerPassword],
      );
      await client.query(rolesSql);
    });

    // 2. Migrations, each in its own transaction, recorded with a checksum.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const appliedChecksums = new Map(rows.map((r) => [r.version, r.checksum]));

    const files = (await readdir(path.join(dbDir, 'migrations')))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    const applied: string[] = [];
    for (const file of files) {
      const body = await readFile(path.join(dbDir, 'migrations', file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const previous = appliedChecksums.get(file);
      if (previous === checksum) continue;
      // Editing an applied migration silently diverges environments: refuse.
      if (previous !== undefined) {
        throw new Error(`Migration ${file} was modified after being applied`);
      }

      log(`applying ${file}`);
      try {
        await inTransaction(client, async () => {
          await client.query(body);
          await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
            file,
            checksum,
          ]);
        });
      } catch (err) {
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => undefined);
    await client.end();
  }
}

async function inTransaction(client: pg.Client, fn: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await fn();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  runMigrations({
    connection: {
      host: required('DATABASE_HOST'),
      port: Number(process.env.DATABASE_PORT ?? 5432),
      database: required('DATABASE_NAME'),
      user: required('DATABASE_MIGRATOR_USER'),
      password: required('DATABASE_MIGRATOR_PASSWORD'),
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
    },
    appPassword: required('DATABASE_APP_PASSWORD'),
    workerPassword: required('DATABASE_WORKER_PASSWORD'),
    log: (m) => process.stdout.write(`[migrate] ${m}\n`),
  })
    .then((applied) => {
      process.stdout.write(`[migrate] done (${applied.length} applied)\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[migrate] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
