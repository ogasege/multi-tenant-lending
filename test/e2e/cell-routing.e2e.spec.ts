import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { Controller, Get, Module } from '@nestjs/common';
import { sql } from 'kysely';
import request from 'supertest';
import { inject } from 'vitest';

import { PlatformAdminOnly, RequirePermissions } from '@/common/auth/decorators';
import { Permission } from '@/common/auth/permissions';
import { TokenService } from '@/common/auth/token.service';
import { TransactionRunner } from '@/common/database/transaction-runner';
import { OutboxWriter } from '@/common/outbox/outbox-writer';
import { AuthModule } from '@/modules/auth/auth.module';
import { DirectoryProjector } from '@/modules/directory/application/directory-projector';
import { DirectoryReconciler } from '@/modules/directory/application/directory-reconciler';
import { DirectoryModule } from '@/modules/directory/directory.module';
import { InstitutionsModule } from '@/modules/institutions/institutions.module';

import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { createTestApp, type TestApp } from '../setup/app';

/** Test-only authenticated routes, to present tokens to a cell. */
@Controller('cell-probe')
class CellProbeController {
  @Get('tenant')
  @RequirePermissions(Permission.PRODUCT_READ)
  tenant(): { ok: true } {
    return { ok: true };
  }

  @Get('platform')
  @PlatformAdminOnly()
  platform(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [CellProbeController] })
class CellProbeModule {}

const MODULES = [DirectoryModule, AuthModule, InstitutionsModule, CellProbeModule];

const CELL_ORIGINS = JSON.stringify({
  'af-south-1': 'http://cell-a.test',
  'eu-west-3': 'http://cell-b.test',
});
const CELL_A = {
  CELL_REGION: 'af-south-1',
  CELL_API_BASE_URL: 'http://cell-a.test',
  CELL_ORIGINS,
};
const CELL_B = { CELL_REGION: 'eu-west-3', CELL_API_BASE_URL: 'http://cell-b.test', CELL_ORIGINS };

const login = (slug: string) => ({
  institutionSlug: slug,
  email: 'credit_officer@nowhere.test',
  password: 'Sup3r-Secret-Pass',
});

/**
 * Two cells in one test run: cell A (af-south-1, database `lending`) and cell B (eu-west-3,
 * its own database). Both share the LocalStack DynamoDB directory table (standing in for the
 * global table's regional replicas), Redis and the JWT signing key.
 */
describe('Global control plane: tenant directory and cell routing', () => {
  let a: TestApp;
  let b: TestApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    a = await createTestApp(MODULES, CELL_A);
    b = await createTestApp(MODULES, {
      ...CELL_B,
      DATABASE_NAME: inject('env').TEST_CELL_B_DATABASE_NAME ?? 'lending_cell_b',
      // Cells share no signing key: a leaked secret in one region cannot forge tokens elsewhere.
      JWT_SECRET: randomBytes(32).toString('hex'),
    });
    tenant = await createTestTenant(a.app);
    // What the cell A worker does: reconcile the directory with A's institutions.
    const summary = await a.app.get(DirectoryReconciler).projectPendingInstitutions();
    expect(summary.applied).toBeGreaterThanOrEqual(1);
  });

  afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
  });

  describe('directory lookup (any cell)', () => {
    it.each([
      ['cell A', () => a],
      ['cell B', () => b],
    ])('%s returns the home cell of a tenant', async (_cell, app) => {
      const res = await request(app().http)
        .get(`/v1/directory/institutions/${tenant.slug}`)
        .expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.body).toEqual({
        slug: tenant.slug,
        homeRegion: 'af-south-1',
        apiBaseUrl: 'http://cell-a.test',
        status: 'ACTIVE',
      });
    });

    it('returns 404 problem details for an unknown slug, never publicly cacheable', async () => {
      const res = await request(b.http)
        .get('/v1/directory/institutions/no-such-lender')
        .expect(404);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(res.headers['cache-control']).toBeUndefined();
    });
  });

  describe('slug-addressed routes on the wrong cell → 307 to the home cell', () => {
    it('redirects login, preserving method and path', async () => {
      const res = await request(b.http).post('/v1/auth/login').send(login(tenant.slug)).expect(307);
      expect(res.headers.location).toBe('http://cell-a.test/v1/auth/login');
      expect(res.headers['x-tenant-cell']).toBe('af-south-1');
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        status: 307,
        code: 'WRONG_CELL',
        homeRegion: 'af-south-1',
        apiBaseUrl: 'http://cell-a.test',
      });
    });

    it('redirects institution routes, preserving the query string', async () => {
      const res = await request(b.http)
        .get(`/v1/institutions/${tenant.slug}/branding?lang=fr`)
        .expect(307);
      expect(res.headers.location).toBe(
        `http://cell-a.test/v1/institutions/${tenant.slug}/branding?lang=fr`,
      );
      expect(res.headers['x-tenant-cell']).toBe('af-south-1');
    });

    it('serves the tenant normally in its home cell (no redirect)', async () => {
      const branding = await request(a.http)
        .get(`/v1/institutions/${tenant.slug}/branding`)
        .expect(200);
      expect(branding.headers.location).toBeUndefined();
      const signIn = await request(a.http).post('/v1/auth/login').send(login(tenant.slug));
      expect(signIn.status).toBe(401);
      expect(signIn.headers.location).toBeUndefined();
    });

    it('treats unknown slugs exactly as before (no enumeration oracle)', async () => {
      const signIn = await request(b.http).post('/v1/auth/login').send(login('no-such-lender'));
      expect(signIn.status).toBe(401);
      expect(signIn.headers.location).toBeUndefined();
      expect(signIn.headers['x-tenant-cell']).toBeUndefined();
      const branding = await request(b.http)
        .get('/v1/institutions/no-such-lender/branding')
        .expect(404);
      expect(branding.headers.location).toBeUndefined();
    });
  });

  describe('tokens are cell-scoped → 421 on another cell', () => {
    it('accepts a tenant token in its issuing cell', async () => {
      await request(a.http)
        .get('/v1/cell-probe/tenant')
        .set('Authorization', `Bearer ${tenant.tokens.CREDIT_OFFICER}`)
        .expect(200);
    });

    it('rejects a tenant token from cell A on cell B with 421 MISDIRECTED_REQUEST', async () => {
      const res = await request(b.http)
        .get('/v1/cell-probe/tenant')
        .set('Authorization', `Bearer ${tenant.tokens.CREDIT_OFFICER}`)
        .expect(421);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        status: 421,
        title: 'Misdirected Request',
        code: 'MISDIRECTED_REQUEST',
        homeRegion: 'af-south-1',
        apiBaseUrl: 'http://cell-a.test',
      });
    });

    it('scopes platform-admin tokens to their cell as well', async () => {
      const token = a.app
        .get(TokenService)
        .issueAccessToken({ kind: 'PLATFORM_ADMIN', id: randomUUID() }).accessToken;
      await request(a.http)
        .get('/v1/cell-probe/platform')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const res = await request(b.http)
        .get('/v1/cell-probe/platform')
        .set('Authorization', `Bearer ${token}`)
        .expect(421);
      expect(res.body).toMatchObject({ code: 'MISDIRECTED_REQUEST', homeRegion: 'af-south-1' });
    });
  });

  describe('status changes are projected', () => {
    it('hides a suspended tenant from the public lookup (404) but keeps routing to its home cell', async () => {
      // What ChangeInstitutionStatus commits in cell A: the row change and its outbox event.
      const runner = a.app.get(TransactionRunner);
      const outbox = a.app.get(OutboxWriter);
      const event = await runner.asPlatformAdmin(
        async (tx) => {
          await tx
            .updateTable('institutions')
            .set({ status: 'SUSPENDED' })
            .where('id', '=', tenant.tenantId)
            .execute();
          const id = await outbox.publish(tx, {
            tenantId: tenant.tenantId,
            type: 'institution.status_changed',
            aggregateType: 'institution',
            aggregateId: tenant.tenantId,
            data: { institutionId: tenant.tenantId, from: 'ACTIVE', to: 'SUSPENDED' },
          });
          const { rows } = await sql<{ version: string }>`
            SELECT ((extract(epoch FROM occurred_at) * 1000000)::bigint)::text AS version
              FROM outbox_events WHERE id = ${id}`.execute(tx);
          return {
            type: 'institution.status_changed',
            version: Number(rows[0]?.version),
            payload: { institutionId: tenant.tenantId, from: 'ACTIVE', to: 'SUSPENDED' },
          };
        },
        { tenantId: tenant.tenantId },
      );

      // The worker's per-event consumer; redelivery and an older replay are no-ops.
      const projector = a.app.get(DirectoryProjector);
      await expect(projector.project(event)).resolves.toBe('applied');
      await expect(projector.project(event)).resolves.toBe('stale');
      await expect(
        projector.project({
          type: 'institution.registered',
          version: event.version - 1,
          payload: { institutionId: tenant.tenantId, slug: tenant.slug },
        }),
      ).resolves.toBe('stale');
      await expect(a.app.get(DirectoryReconciler).projectPendingInstitutions()).resolves.toEqual(
        expect.objectContaining({ applied: 0 }),
      );

      const res = await request(b.http)
        .get(`/v1/directory/institutions/${tenant.slug}`)
        .expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(res.headers['cache-control']).toBeUndefined();
      // Routing still uses the internal entry: the home cell owns the "suspended" answer.
      await request(b.http).post('/v1/auth/login').send(login(tenant.slug)).expect(307);
    });
  });
});
