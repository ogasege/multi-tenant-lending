import pg from 'pg';
import { inject } from 'vitest';

import { AuditWriter, verifyAuditChain } from '@/common/audit/audit-writer';
import { TransactionRunner } from '@/common/database/transaction-runner';
import { OutboxWriter } from '@/common/outbox/outbox-writer';

import { createTestApp, type TestApp } from '../setup/app';
import { TEST_DB } from '../setup/postgres';
import { createTestTenant, type TestTenant } from '../fixtures/tenants';

describe('audit chain and transactional outbox', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let runner: TransactionRunner;

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTestTenant(t.app);
    runner = t.app.get(TransactionRunner);
  });

  afterAll(async () => {
    await t.close();
  });

  it('builds a verifiable per-tenant chain', async () => {
    const audit = t.app.get(AuditWriter);
    for (const n of [1, 2, 3]) {
      await runner.runForTenant(tenant.tenantId, (tx) =>
        audit.record(tx, {
          tenantId: tenant.tenantId,
          action: 'test.event',
          entityType: 'test',
          entityId: String(n),
          after: { n, amount: BigInt(n) * 100n },
        }),
      );
    }
    const result = await runner.runForTenant(tenant.tenantId, (tx) =>
      verifyAuditChain(tx, tenant.tenantId),
    );
    expect(result).toEqual({ valid: true, entriesChecked: 3 });
  });

  it('detects tampering even by someone able to bypass the append-only trigger', async () => {
    const env = inject('env');
    // The schema owner can disable triggers on its own tables: simulate a rogue DBA.
    const owner = new pg.Client({
      host: env.DATABASE_HOST,
      port: Number(env.DATABASE_PORT),
      database: env.DATABASE_NAME,
      user: TEST_DB.owner,
      password: TEST_DB.ownerPassword,
    });
    await owner.connect();
    try {
      await owner.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only');
      await owner.query("SELECT set_config('app.tenant_id', $1, false)", [tenant.tenantId]);
      await owner.query(
        `UPDATE audit_log SET after_state = '{"n": 2, "amount": "999999"}'
          WHERE tenant_id = $1 AND entity_id = '2'`,
        [tenant.tenantId],
      );
    } finally {
      await owner.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only');
      await owner.end();
    }
    const result = await runner.runForTenant(tenant.tenantId, (tx) =>
      verifyAuditChain(tx, tenant.tenantId),
    );
    expect(result.valid).toBe(false);
    expect(result.firstBrokenEntryId).toBeDefined();
  });

  it('writes outbox events only when the business transaction commits', async () => {
    const outbox = t.app.get(OutboxWriter);
    const event = {
      tenantId: tenant.tenantId,
      type: 'loan.disbursed' as const,
      aggregateType: 'test',
      aggregateId: 'x',
      data: { amount: 10n },
    };
    await expect(
      runner.runForTenant(tenant.tenantId, async (tx) => {
        await outbox.publish(tx, { ...event, aggregateId: 'rolled-back' });
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');
    await runner.runForTenant(tenant.tenantId, (tx) => outbox.publish(tx, event));

    const rows = await runner.runForTenant(tenant.tenantId, (tx) =>
      tx.selectFrom('outbox_events').select(['aggregate_id', 'payload']).execute(),
    );
    expect(rows.map((r) => r.aggregate_id)).toEqual(['x']);
    expect(rows[0]?.payload).toEqual({ amount: '10' });
  });
});
