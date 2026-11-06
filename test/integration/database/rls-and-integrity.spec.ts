import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type pg from 'pg';

import { runMigrations } from '@/common/database/migrate';

import { clientFor, startPostgres, TEST_DB, type TestPostgres } from '../../setup/postgres';

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

  async function seedInstitution(id: string, slug: string): Promise<void> {
    await inTenant(app, id, async () => {
      await app.query(
        `INSERT INTO institutions (id, slug, legal_name, country_code, default_currency, supported_currencies, lender_type)
         VALUES ($1, $2, $3, 'NG', 'NGN', '{NGN}', 'MICROFINANCE_BANK')`,
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
    await pgc.container.stop();
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

describe('migration runner', () => {
  it('is safe to re-run (every deploy runs it) and rejects edited migrations', async () => {
    const pgc = await startPostgres();
    try {
      const again = await runMigrations({
        connection: {
          host: pgc.host,
          port: pgc.port,
          database: TEST_DB.name,
          user: TEST_DB.owner,
          password: TEST_DB.ownerPassword,
        },
        appPassword: 'rotated-app-pw',
        workerPassword: 'rotated-worker-pw',
        dbDir: path.resolve(__dirname, '../../../db'),
      });
      expect(again).toEqual([]);
    } finally {
      await pgc.container.stop();
    }
  }, 180_000);
});
