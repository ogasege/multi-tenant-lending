import { randomUUID } from 'node:crypto';
import { appendFile, cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';

import {
  clientFor,
  createDatabase,
  DB_DIR,
  migrate,
  runFlyway,
  SERVER_LOG,
  startPostgres,
  TEST_DB,
  type TestPostgres,
} from '../../setup/postgres';

/**
 * Database-level guarantees, tested directly against Postgres with the real runtime roles.
 * These hold even if application code has a bug — that is the point of defence in depth.
 */
describe('database guarantees (RLS, ledger, audit)', () => {
  let pgc: TestPostgres;
  let app: pg.Client;
  let worker: pg.Client;
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  async function inTenant<T>(
    client: pg.Client,
    tenant: string | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    await client.query('BEGIN');
    try {
      if (tenant) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const out = await fn();
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  async function countRows(client: pg.Client, table: string): Promise<number> {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
    return Number(rows[0]!.n);
  }

  /** Mirrors platform registration: platform scope + the new tenant pinned. */
  async function seedInstitution(id: string, slug: string): Promise<void> {
    await inTenant(app, id, async () => {
      await app.query("SELECT set_config('app.platform_admin', 'on', true)");
      await app.query(
        `INSERT INTO institutions (id, slug, legal_name, country_code, default_currency, supported_currencies, lender_type, home_region)
         VALUES ($1, $2, $3, 'NG', 'NGN', '{NGN}', 'MICROFINANCE_BANK', 'af-south-1')`,
        [id, slug, `${slug} Ltd`],
      );
      await app.query(
        `INSERT INTO ledger_accounts (tenant_id, code, name, type, normal_balance, currency)
         VALUES ($1, '1000', 'Cash', 'ASSET', 'DEBIT', 'NGN'), ($1, '4100', 'Fee Income', 'INCOME', 'CREDIT', 'NGN')`,
        [id],
      );
    });
  }

  beforeAll(async () => {
    pgc = await startPostgres();
    app = clientFor(pgc, 'app');
    worker = clientFor(pgc, 'worker');
    await app.connect();
    await worker.connect();
    await seedInstitution(tenantA, 'bank-a');
    await seedInstitution(tenantB, 'bank-b');
  }, 180_000);

  afterAll(async () => {
    await app.end();
    await worker.end();
    await pgc.stop();
  });

  describe('row-level security', () => {
    it('shows a tenant only its own rows', async () => {
      const rows = await inTenant(
        app,
        tenantA,
        async () =>
          (await app.query<{ tenant_id: string }>('SELECT tenant_id FROM ledger_accounts')).rows,
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    });

    it('fails closed: no tenant context => zero rows, not an error', async () => {
      const count = await inTenant(app, null, () => countRows(app, 'ledger_accounts'));
      expect(count).toBe(0);
    });

    it('rejects writes into another tenant (WITH CHECK)', async () => {
      await expect(
        inTenant(app, tenantA, () =>
          app.query(
            `INSERT INTO ledger_accounts (tenant_id, code, name, type, normal_balance, currency)
             VALUES ($1, '9999', 'Sneaky', 'ASSET', 'DEBIT', 'NGN')`,
            [tenantB],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("cannot update or delete another tenant's rows (silently affects 0 rows)", async () => {
      const res = await inTenant(app, tenantA, () =>
        app.query("UPDATE ledger_accounts SET name = 'pwned' WHERE tenant_id = $1", [tenantB]),
      );
      expect(res.rowCount).toBe(0);
    });

    it('a tenant context does not leak to the next transaction on the same connection', async () => {
      await inTenant(app, tenantA, () => app.query('SELECT 1'));
      const n = await inTenant(app, null, () => countRows(app, 'institutions'));
      expect(n).toBe(0);
    });

    it('lets the worker role read across tenants via its explicit policy', async () => {
      const n = await countRows(worker, 'institutions');
      expect(n).toBe(2);
    });

    it('resolves a public slug through the SECURITY DEFINER function without a tenant context', async () => {
      const res = await app.query('SELECT id, status FROM resolve_institution($1)', ['bank-b']);
      expect(res.rows).toEqual([{ id: tenantB, status: 'ACTIVE' }]);
    });

    it('lets platform admins see all institutions only when the platform scope is set', async () => {
      const n = await inTenant(app, null, async () => {
        await app.query("SELECT set_config('app.platform_admin', 'on', true)");
        return countRows(app, 'institutions');
      });
      expect(n).toBe(2);
    });
  });

  describe('double-entry ledger', () => {
    async function accountIds(tenant: string): Promise<Record<string, string>> {
      return inTenant(app, tenant, async () =>
        Object.fromEntries(
          (
            await app.query<{ code: string; id: string }>('SELECT code, id FROM ledger_accounts')
          ).rows.map((r) => [r.code, r.id]),
        ),
      );
    }

    it('accepts a balanced journal entry', async () => {
      const acc = await accountIds(tenantA);
      await inTenant(app, tenantA, async () => {
        const je = await app.query<{ id: string }>(
          `INSERT INTO journal_entries (tenant_id, kind, currency, description, effective_date, idempotency_ref)
           VALUES ($1, 'REPAYMENT', 'NGN', 'balanced', CURRENT_DATE, $2) RETURNING id`,
          [tenantA, `test:${randomUUID()}`],
        );
        await app.query(
          `INSERT INTO postings (tenant_id, journal_entry_id, account_id, direction, amount, currency)
           VALUES ($1, $2, $3, 'DEBIT', 5000, 'NGN'), ($1, $2, $4, 'CREDIT', 5000, 'NGN')`,
          [tenantA, je.rows[0]!.id, acc['1000'], acc['4100']],
        );
      });
    });

    it('rejects an unbalanced journal entry at COMMIT', async () => {
      const acc = await accountIds(tenantA);
      await expect(
        inTenant(app, tenantA, async () => {
          const je = await app.query<{ id: string }>(
            `INSERT INTO journal_entries (tenant_id, kind, currency, description, effective_date, idempotency_ref)
             VALUES ($1, 'REPAYMENT', 'NGN', 'unbalanced', CURRENT_DATE, $2) RETURNING id`,
            [tenantA, `test:${randomUUID()}`],
          );
          await app.query(
            `INSERT INTO postings (tenant_id, journal_entry_id, account_id, direction, amount, currency)
             VALUES ($1, $2, $3, 'DEBIT', 5000, 'NGN'), ($1, $2, $4, 'CREDIT', 4999, 'NGN')`,
            [tenantA, je.rows[0]!.id, acc['1000'], acc['4100']],
          );
        }),
      ).rejects.toThrow(/unbalanced/);
    });

    it('forbids editing or deleting postings (append-only)', async () => {
      await expect(
        inTenant(app, tenantA, () => app.query('UPDATE postings SET amount = 1')),
      ).rejects.toThrow();
      await expect(
        inTenant(app, tenantA, () => app.query('DELETE FROM journal_entries')),
      ).rejects.toThrow();
    });
  });

  describe('audit log', () => {
    it('is append-only even for the worker role', async () => {
      await inTenant(app, tenantA, () =>
        app.query(
          `INSERT INTO audit_log (tenant_id, actor_type, action, entity_type, entity_id, prev_hash, hash)
           VALUES ($1, 'SYSTEM', 'test.created', 'test', '1', 'GENESIS', $2)`,
          [tenantA, randomUUID()],
        ),
      );
      await expect(worker.query("UPDATE audit_log SET action = 'tampered'")).rejects.toThrow();
      await expect(worker.query('DELETE FROM audit_log')).rejects.toThrow();
      await expect(worker.query('TRUNCATE audit_log')).rejects.toThrow();
    });
  });

  describe('platform-controlled data', () => {
    it('lets a tenant read but never modify its own institution row (status, APR cap)', async () => {
      const res = await inTenant(app, tenantA, async () => {
        const visible = await countRows(app, 'institutions');
        const updated = await app.query(
          "UPDATE institutions SET status = 'ACTIVE', max_apr_bps = 99999 WHERE id = $1",
          [tenantA],
        );
        return { visible, updated: updated.rowCount };
      });
      expect(res).toEqual({ visible: 1, updated: 0 });
    });

    it('hides platform admin credentials outside the platform auth scope', async () => {
      await inTenant(app, null, async () => {
        await app.query("SELECT set_config('app.platform_auth', 'on', true)");
        await app.query(
          `INSERT INTO platform_admins (email, password_hash, full_name) VALUES ('ops@10mg.ai', 'hash', 'Ops')`,
        );
      });
      expect(await inTenant(app, tenantA, () => countRows(app, 'platform_admins'))).toBe(0);
      expect(
        await inTenant(app, null, async () => {
          await app.query("SELECT set_config('app.platform_auth', 'on', true)");
          return countRows(app, 'platform_admins');
        }),
      ).toBe(1);
    });
  });

  describe('data residency (home_region)', () => {
    async function insertInstitution(homeRegion: string | null): Promise<void> {
      const id = randomUUID();
      await inTenant(app, id, async () => {
        await app.query("SELECT set_config('app.platform_admin', 'on', true)");
        await app.query(
          `INSERT INTO institutions (id, slug, legal_name, country_code, default_currency, supported_currencies, lender_type, home_region)
           VALUES ($1, $2, 'Residency Ltd', 'NG', 'NGN', '{NGN}', 'MICROFINANCE_BANK', $3)`,
          [id, `res-${id.slice(0, 8)}`, homeRegion],
        );
      });
    }

    it.each(['AF-SOUTH-1', 'af-south', 'af_south_1', 'lagos', ''])(
      'rejects the malformed region %j',
      async (region) => {
        await expect(insertInstitution(region)).rejects.toThrow(/check constraint/);
      },
    );

    it('requires an explicit region: NOT NULL and no default after the backfill', async () => {
      await expect(insertInstitution(null)).rejects.toThrow(/not-null constraint/);
      const { rows } = await app.query<{ column_default: string | null }>(
        `SELECT column_default FROM information_schema.columns
          WHERE table_name = 'institutions' AND column_name = 'home_region'`,
      );
      expect(rows).toEqual([{ column_default: null }]);
    });

    it('accepts a well-formed AWS region', async () => {
      await expect(insertInstitution('eu-west-3')).resolves.toBeUndefined();
    });
  });

  describe('checkout order single use (V5)', () => {
    interface Applicant {
      customerId: string;
      productId: string;
      productVersionId: string;
      userId: string;
    }
    const applicants = new Map<string, Applicant>();

    /** One user, customer and product version per tenant: the FKs an application needs. */
    async function applicantFor(tenant: string): Promise<Applicant> {
      const cached = applicants.get(tenant);
      if (cached) return cached;
      const created = await inTenant(app, tenant, async () => {
        const tag = randomUUID().slice(0, 8);
        const user = await app.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, password_hash, full_name, role)
           VALUES ($1, $2, 'hash', 'Ada Obi', 'CUSTOMER') RETURNING id`,
          [tenant, `ada-${tag}@example.com`],
        );
        const userId = user.rows[0]!.id;
        const customer = await app.query<{ id: string }>(
          `INSERT INTO customers (tenant_id, user_id, reference, customer_type, first_name, last_name,
                                  email, phone, date_of_birth, national_id_hmac, national_id_last4,
                                  employment_status, currency, monthly_income)
           VALUES ($1, $2, $3, 'INDIVIDUAL', 'Ada', 'Obi', $4, '+2348000000000', '1990-01-01',
                   $5, '1234', 'BUSINESS_OWNER', 'NGN', 50000000) RETURNING id`,
          [tenant, userId, `CUS-${tag}`, `ada-${tag}@example.com`, `hmac-${tag}`],
        );
        const product = await app.query<{ id: string }>(
          `INSERT INTO loan_products (tenant_id, code, name) VALUES ($1, $2, 'Stock finance')
           RETURNING id`,
          [tenant, `SF-${tag.toUpperCase()}`],
        );
        const productId = product.rows[0]!.id;
        const version = await app.query<{ id: string }>(
          `INSERT INTO loan_product_versions (tenant_id, product_id, version, currency,
                                              min_principal, max_principal, min_term, max_term,
                                              repayment_frequency, interest_method,
                                              annual_interest_rate_bps, origination_fee_type,
                                              late_fee_type)
           VALUES ($1, $2, 1, 'NGN', 100000, 100000000, 1, 12, 'MONTHLY', 'REDUCING_BALANCE',
                   3000, 'NONE', 'NONE') RETURNING id`,
          [tenant, productId],
        );
        return {
          customerId: customer.rows[0]!.id,
          productId,
          productVersionId: version.rows[0]!.id,
          userId,
        };
      });
      applicants.set(tenant, created);
      return created;
    }

    async function submitApplication(tenant: string, orderRef: string | null): Promise<string> {
      const a = await applicantFor(tenant);
      return inTenant(app, tenant, async () => {
        const res = await app.query<{ id: string }>(
          `INSERT INTO loan_applications (tenant_id, reference, customer_id, product_id,
                                          product_version_id, currency, requested_principal, term,
                                          payee_type, payee_name, payee_account,
                                          external_order_reference, status, submitted_by)
           VALUES ($1, $2, $3, $4, $5, 'NGN', 2500000, 3, 'VENDOR', 'Emzor Pharma',
                   '0123456789', $6, 'SUBMITTED', $7) RETURNING id`,
          [
            tenant,
            `APP-${randomUUID()}`,
            a.customerId,
            a.productId,
            a.productVersionId,
            orderRef,
            a.userId,
          ],
        );
        return res.rows[0]!.id;
      });
    }

    async function setStatus(tenant: string, id: string, status: string): Promise<void> {
      await inTenant(app, tenant, () =>
        app.query('UPDATE loan_applications SET status = $2 WHERE id = $1', [id, status]),
      );
    }

    const duplicateOrder = expect.objectContaining({
      code: '23505', // unique_violation
      constraint: 'loan_applications_order_once',
    });

    it('rejects a second live application for the same order in the same tenant', async () => {
      const order = `PO-${randomUUID()}`;
      await submitApplication(tenantA, order);
      await expect(submitApplication(tenantA, order)).rejects.toEqual(duplicateOrder);
    });

    it('keeps the order held while the first application is ASSESSED or APPROVED', async () => {
      const order = `PO-${randomUUID()}`;
      const first = await submitApplication(tenantA, order);
      for (const status of ['ASSESSED', 'APPROVED']) {
        await setStatus(tenantA, first, status);
        await expect(submitApplication(tenantA, order)).rejects.toEqual(duplicateOrder);
      }
    });

    it('lets a different tenant finance the same order reference', async () => {
      const order = `PO-${randomUUID()}`;
      await submitApplication(tenantA, order);
      await expect(submitApplication(tenantB, order)).resolves.toEqual(expect.any(String));
    });

    it.each(['REJECTED', 'WITHDRAWN', 'EXPIRED'])(
      'frees the order once the first application is %s',
      async (status) => {
        const order = `PO-${randomUUID()}`;
        const first = await submitApplication(tenantA, order);
        await setStatus(tenantA, first, status);
        await expect(submitApplication(tenantA, order)).resolves.toEqual(expect.any(String));
      },
    );

    it('blocks reviving a freed application while a newer one holds the order', async () => {
      const order = `PO-${randomUUID()}`;
      const first = await submitApplication(tenantA, order);
      await setStatus(tenantA, first, 'WITHDRAWN');
      await submitApplication(tenantA, order);
      await expect(setStatus(tenantA, first, 'SUBMITTED')).rejects.toEqual(duplicateOrder);
    });

    it('does not constrain applications without an order reference', async () => {
      await submitApplication(tenantA, null);
      await expect(submitApplication(tenantA, null)).resolves.toEqual(expect.any(String));
    });
  });

  describe('least privilege', () => {
    it('denies DDL to the runtime roles', async () => {
      await expect(app.query('CREATE TABLE evil (id int)')).rejects.toThrow(/permission denied/);
      await expect(app.query('DROP TABLE loans')).rejects.toThrow();
    });

    it('denies the worker role access to platform admin credentials', async () => {
      await expect(worker.query('SELECT * FROM platform_admins')).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});

describe('migrations (Flyway)', () => {
  let pgc: TestPostgres;

  beforeAll(async () => {
    // Statement logging on: the last test asserts no SQL text the server saw (or logged
    // for an error) contains a password verifier.
    pgc = await startPostgres({ logStatements: true });
  }, 240_000);

  async function asSuperuser<T>(fn: (su: pg.Client) => Promise<T>): Promise<T> {
    const su = new pg.Client({ connectionString: pgc.container.getConnectionUri() });
    await su.connect();
    try {
      return await fn(su);
    } finally {
      await su.end();
    }
  }

  afterAll(async () => {
    await pgc.stop();
  });

  async function appliedVersions(): Promise<string[]> {
    const owner = clientFor(pgc, 'owner');
    await owner.connect();
    try {
      const { rows } = await owner.query<{ version: string }>(
        `SELECT version FROM flyway_history.flyway_schema_history
          WHERE success AND version IS NOT NULL ORDER BY installed_rank`,
      );
      return rows.map((r) => r.version);
    } finally {
      await owner.end();
    }
  }

  // Runs first: later tests rotate the runtime roles' passwords.
  it('keeps migration history out of reach of the runtime roles', async () => {
    for (const role of ['app', 'worker'] as const) {
      const client = clientFor(pgc, role);
      await client.connect();
      try {
        await expect(
          client.query('SELECT * FROM flyway_history.flyway_schema_history'),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.end();
      }
    }
  });

  it('is safe to re-run (every deploy runs it): applies nothing, rotates passwords', async () => {
    const before = await appliedVersions();
    const logs = await migrate(pgc, {
      appPassword: 'rotated-app-pw',
      workerPassword: 'rotated-worker-pw',
    });

    expect(logs).toMatch(/No migration necessary/);
    expect(await appliedVersions()).toEqual(before);

    const rotated = new pg.Client({
      host: pgc.host,
      port: pgc.port,
      database: TEST_DB.name,
      user: 'lending_app',
      password: 'rotated-app-pw',
    });
    await rotated.connect();
    await rotated.end();
  }, 180_000);

  it('passes passwords to the role bootstrap as literals, not SQL', async () => {
    const tricky = `it's $$ a \\ "tricky" | pw`;
    await migrate(pgc, { appPassword: tricky, workerPassword: TEST_DB.workerPassword });
    const app = new pg.Client({
      host: pgc.host,
      port: pgc.port,
      database: TEST_DB.name,
      user: 'lending_app',
      password: tricky,
    });
    await app.connect();
    await app.end();
  }, 180_000);

  it('stores SCRAM-SHA-256 verifiers, never sends plaintext, and the passwords log in', async () => {
    const appPassword = 'scram-app-pw';
    const workerPassword = 'scram-worker-pw';
    const logs = await migrate(pgc, { appPassword, workerPassword });
    expect(logs).not.toContain(appPassword);
    expect(logs).not.toContain(workerPassword);

    // pg_authid.rolpassword is readable by superusers only.
    const su = new pg.Client({ connectionString: pgc.container.getConnectionUri() });
    await su.connect();
    try {
      const { rows } = await su.query<{ rolname: string; rolpassword: string }>(
        `SELECT rolname, rolpassword FROM pg_authid
          WHERE rolname IN ('lending_app', 'lending_worker') ORDER BY rolname`,
      );
      expect(rows.map((r) => r.rolname)).toEqual(['lending_app', 'lending_worker']);
      for (const { rolpassword } of rows) {
        expect(rolpassword).toMatch(
          /^SCRAM-SHA-256\$100000:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/,
        );
      }
    } finally {
      await su.end();
    }

    for (const [user, password] of [
      ['lending_app', appPassword],
      ['lending_worker', workerPassword],
    ] as const) {
      const client = new pg.Client({
        host: pgc.host,
        port: pgc.port,
        database: TEST_DB.name,
        user,
        password,
      });
      await client.connect();
      await client.end();
    }
  }, 180_000);

  it('refuses passwords SASLprep would alter (non-ASCII) before touching the database', async () => {
    const result = await runFlyway(pgc, { appPassword: 'pässwörd' });
    expect(result.ok).toBe(false);
    expect(result.logs).toMatch(/DATABASE_APP_PASSWORD must be printable ASCII/);
  }, 180_000);

  it('refuses a plaintext password handed straight to Flyway', async () => {
    // Bypasses the entrypoint's hashing by handing Flyway's session a plaintext value.
    const result = await runFlyway(pgc, {
      env: {
        FLYWAY_URL: `jdbc:postgresql://postgres:5432/${TEST_DB.name}?sslmode=disable`,
        FLYWAY_USER: TEST_DB.owner,
        FLYWAY_PASSWORD: TEST_DB.ownerPassword,
        FLYWAY_JDBC_PROPERTIES_options:
          '-c bootstrap.app_scram=plaintext-pw -c bootstrap.worker_scram=plaintext-pw',
      },
      entrypoint: ['flyway', '-configFiles=db/flyway.toml'],
    });
    expect(result.ok).toBe(false);
    expect(result.logs).toMatch(/not a SCRAM-SHA-256 verifier/);
  }, 180_000);

  it('refuses to run when an applied migration was edited (checksum mismatch)', async () => {
    const edited = await mkdtemp(path.join(tmpdir(), 'lending-db-'));
    try {
      await cp(DB_DIR, edited, { recursive: true });
      await appendFile(
        path.join(edited, 'migrations', 'V1__core_schema.sql'),
        '\n-- edited after it was applied\n',
      );
      const before = await appliedVersions();

      for (const command of ['validate', 'migrate']) {
        const result = await runFlyway(pgc, { args: [command], dbDir: edited });
        expect(result.ok).toBe(false);
        expect(result.logs).toMatch(/checksum mismatch for migration version 1/i);
      }
      expect(await appliedVersions()).toEqual(before);
    } finally {
      await rm(edited, { recursive: true, force: true });
    }
  }, 180_000);

  it('creates the keyset pagination indexes (V4)', async () => {
    const owner = clientFor(pgc, 'owner');
    await owner.connect();
    try {
      const { rows } = await owner.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname LIKE '%\\_created\\_idx' ORDER BY indexname`,
      );
      const defs = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
      const tenantTables = [
        'customers',
        'loan_applications',
        'loan_products',
        'loans',
        'repayments',
        'users',
        'webhook_endpoints',
      ];
      for (const table of tenantTables) {
        expect(defs[`${table}_created_idx`]).toContain(
          `ON public.${table} USING btree (tenant_id, created_at DESC, id DESC)`,
        );
      }
      expect(defs.institutions_created_idx).toContain(
        'ON public.institutions USING btree (created_at DESC, id DESC)',
      );
    } finally {
      await owner.end();
    }
  });

  it('never allows `flyway clean`', async () => {
    const result = await runFlyway(pgc, { args: ['clean'] });
    expect(result.ok).toBe(false);
    expect(result.logs).toMatch(/cleanDisabled/);
    expect((await appliedVersions()).length).toBeGreaterThan(0);
  }, 180_000);

  it('leaves migration history unreachable for the runtime roles when a migration fails', async () => {
    // A fresh database where every real migration commits (V1 grants DML on ALL TABLES IN
    // SCHEMA public) and a planted next version then fails, so afterMigrate never runs.
    const committed = (await readdir(path.join(DB_DIR, 'migrations')))
      .map((f) => /^V(\d+)__.*\.sql$/.exec(f)?.[1])
      .filter((v): v is string => v !== undefined)
      .sort((a, b) => Number(a) - Number(b));
    const failing = String(Number(committed.at(-1)) + 1);
    const database = 'lending_failed_run';
    await createDatabase(pgc, database);
    const broken = await mkdtemp(path.join(tmpdir(), 'lending-db-'));
    try {
      await cp(DB_DIR, broken, { recursive: true });
      await writeFile(path.join(broken, 'migrations', `V${failing}__fails.sql`), 'SELECT 1/0;\n');
      const result = await runFlyway(pgc, { dbDir: broken, database });
      expect(result.ok).toBe(false);
      expect(result.logs).toContain(`version "${failing} - fails" failed`);
      expect(result.logs).toMatch(/Executing SQL callback: afterMigrateError/);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }

    for (const [user, password] of [
      ['lending_app', TEST_DB.appPassword],
      ['lending_worker', TEST_DB.workerPassword],
    ] as const) {
      const client = new pg.Client({ host: pgc.host, port: pgc.port, database, user, password });
      await client.connect();
      try {
        const { rows } = await client.query<{ usage: boolean }>(
          "SELECT has_schema_privilege('flyway_history', 'USAGE') AS usage",
        );
        expect(rows).toEqual([{ usage: false }]);
        await expect(
          client.query('UPDATE flyway_history.flyway_schema_history SET success = true'),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await client.end();
      }
    }
    // The scenario is real: every real migration committed (with V1's broad grant) and the
    // planted one did not.
    const owner = new pg.Client({
      host: pgc.host,
      port: pgc.port,
      database,
      user: TEST_DB.owner,
      password: TEST_DB.ownerPassword,
    });
    await owner.connect();
    try {
      const { rows } = await owner.query<{ version: string }>(
        `SELECT version FROM flyway_history.flyway_schema_history
          WHERE success AND version IS NOT NULL ORDER BY installed_rank`,
      );
      expect(rows.map((r) => r.version)).toEqual(committed);
      const grant = await owner.query<{ granted: boolean }>(
        "SELECT has_table_privilege('lending_app', 'public.loans', 'INSERT') AS granted",
      );
      expect(grant.rows).toEqual([{ granted: true }]);
    } finally {
      await owner.end();
    }
  }, 180_000);

  // Runs last: it inspects the server log of everything this suite sent.
  it('never puts a password verifier into SQL text, even when the role bootstrap fails', async () => {
    // Force CREATE/ALTER ROLE to fail: without CREATEROLE the owner cannot rotate passwords.
    await asSuperuser((su) => su.query(`ALTER ROLE ${TEST_DB.owner} NOCREATEROLE`));
    try {
      const result = await runFlyway(pgc);
      expect(result.ok).toBe(false);
      expect(result.logs).toMatch(
        /creating\/rotating role lending_app failed: permission denied to alter role/,
      );
      expect(result.logs).not.toMatch(/SCRAM-SHA-256\$/);
    } finally {
      await asSuperuser((su) => su.query(`ALTER ROLE ${TEST_DB.owner} CREATEROLE`));
    }

    const { output } = await pgc.container.exec(['cat', SERVER_LOG]);
    // Logging really captured the bootstrap and its failure...
    // pgjdbc uses the extended protocol: statements are logged as `execute <name>:`.
    expect(output).toMatch(/(statement|execute [^:]*): -- Flyway `beforeMigrate` callback/);
    expect(output).toMatch(/ERROR: {2}creating\/rotating role lending_app failed/);
    // ...and no statement, error or CONTEXT line carries a verifier.
    expect(output).not.toMatch(/SCRAM-SHA-256\$/);
    // (The harness's own CREATE ROLE for the owner is logged; the runtime roles' never are.)
    expect(output).not.toMatch(/ROLE "?lending_(app|worker)"? PASSWORD/i);
  }, 180_000);
});
