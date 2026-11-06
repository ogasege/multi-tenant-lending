import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import request from 'supertest';

import { verifyAuditChain } from '@/common/audit/audit-writer';
import { TransactionRunner } from '@/common/database/transaction-runner';

import {
  IDENTITY_MODULES,
  jwtClaims,
  type PageBody,
  type SessionBody,
  type StaffBody,
  STRONG_PASSWORD,
} from '../fixtures/identity';
import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { createTestApp, type TestApp } from '../setup/app';

describe('Tenant authentication and staff management', () => {
  let t: TestApp;
  let tenant: TestTenant;

  const createStaff = (role = 'CREDIT_OFFICER', token = tenant.tokens.INSTITUTION_ADMIN) =>
    request(t.http)
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `Staff-${randomUUID().slice(0, 8)}@lender.test`,
        fullName: 'Chidi Okeke',
        role,
        password: STRONG_PASSWORD,
      });

  const login = (email: string, password = STRONG_PASSWORD, slug = tenant.slug) =>
    request(t.http).post('/v1/auth/login').send({ institutionSlug: slug, email, password });

  const refresh = (refreshToken: string) =>
    request(t.http).post('/v1/auth/refresh').send({ refreshToken });

  beforeAll(async () => {
    t = await createTestApp(IDENTITY_MODULES);
    tenant = await createTestTenant(t.app);
  });

  afterAll(async () => {
    await t.close();
  });

  describe('sign-in', () => {
    it('signs a staff user in with a tenant token carrying tid and role', async () => {
      const staff = (await createStaff().expect(201)).body as StaffBody;
      expect(staff.email).toBe(staff.email.toLowerCase());
      const res = await login(staff.email).expect(200);
      expect(jwtClaims((res.body as SessionBody).accessToken)).toMatchObject({
        aud: 'tenant',
        tid: tenant.tenantId,
        role: 'CREDIT_OFFICER',
        sub: staff.id,
      });
    });

    it('answers unknown institution, unknown email and wrong password identically', async () => {
      const staff = (await createStaff().expect(201)).body as StaffBody;
      const responses = await Promise.all([
        login(staff.email, STRONG_PASSWORD, 'no-such-lender'),
        login('nobody@lender.test'),
        login(staff.email, 'Wrong-Password-1'),
      ]);
      const [first] = responses;
      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('INVALID_CREDENTIALS');
        expect(res.body.detail).toBe(first.body.detail);
      }
    });

    it('locks after 5 failures with the same 401, audits it and emits auth.account_locked', async () => {
      const staff = (await createStaff().expect(201)).body as StaffBody;
      const wrong = await login(staff.email, 'Wrong-Password-1').expect(401);
      for (let i = 0; i < 3; i++) await login(staff.email, 'Wrong-Password-1').expect(401);
      const locked = await login(staff.email, 'Wrong-Password-1').expect(401);
      // Locked is indistinguishable from a wrong password, even with the right password.
      const right = await login(staff.email).expect(401);
      for (const res of [locked, right]) {
        expect(res.body).toMatchObject({ code: 'INVALID_CREDENTIALS', detail: wrong.body.detail });
      }

      const { audit, events } = await t.app
        .get(TransactionRunner)
        .runForTenant(tenant.tenantId, async (tx) => ({
          audit: await tx
            .selectFrom('audit_log')
            .select('action')
            .where('entity_id', '=', staff.id)
            .where('action', '=', 'auth.account_locked')
            .execute(),
          events: await tx
            .selectFrom('outbox_events')
            .select('event_type')
            .where('aggregate_id', '=', staff.id)
            .where('event_type', '=', 'auth.account_locked')
            .execute(),
        }));
      expect(audit).toHaveLength(1);
      expect(events).toHaveLength(1);
    });

    it('audits sign-in success, failure and sign-out with IP and user agent, in a valid chain', async () => {
      const staff = (await createStaff().expect(201)).body as StaffBody;
      await login(staff.email, 'Wrong-Password-1').expect(401);
      const session = (await login(staff.email).expect(200)).body as SessionBody;
      await request(t.http)
        .post('/v1/auth/logout')
        .set('User-Agent', 'e2e-agent/1.0')
        .send({ refreshToken: session.refreshToken })
        .expect(204);

      const runner = t.app.get(TransactionRunner);
      const { rows, chain } = await runner.runForTenant(tenant.tenantId, async (tx) => ({
        rows: await tx
          .selectFrom('audit_log')
          .select(['action', 'actor_type', 'actor_id', 'ip_address', 'user_agent', 'after_state'])
          .where('entity_id', '=', staff.id)
          .where('action', 'like', 'auth.%')
          .orderBy('id')
          .execute(),
        chain: await verifyAuditChain(tx, tenant.tenantId),
      }));
      expect(rows.map((r) => r.action)).toEqual([
        'auth.login_failed',
        'auth.login_succeeded',
        'auth.logout',
      ]);
      expect(rows[0]?.after_state).toEqual({ reason: 'bad_credentials' });
      expect(rows[1]).toMatchObject({ actor_type: 'USER', actor_id: staff.id });
      expect(rows[2]).toMatchObject({ actor_id: staff.id, user_agent: 'e2e-agent/1.0' });
      expect(rows.every((r) => r.ip_address !== null)).toBe(true);
      expect(chain.valid).toBe(true);
    });

    it('rejects a disabled user with INVALID_CREDENTIALS', async () => {
      const staff = (await createStaff().expect(201)).body as StaffBody;
      await request(t.http)
        .patch(`/v1/users/${staff.id}`)
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .send({ status: 'DISABLED' })
        .expect(200);
      expect((await login(staff.email).expect(401)).body.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('refresh and logout', () => {
    it('rotates tokens; reusing a rotated token revokes the family and is audited', async () => {
      const staff = (await createStaff().expect(201)).body as StaffBody;
      const first = ((await login(staff.email).expect(200)).body as SessionBody).refreshToken;
      const second = (await refresh(first).expect(200)).body as SessionBody;
      expect(second.refreshToken).not.toBe(first);
      expect(second.accessToken).toEqual(expect.any(String));

      const reuse = await refresh(first).expect(401);
      expect(reuse.body.code).toBe('INVALID_REFRESH_TOKEN');
      await refresh(second.refreshToken).expect(401);

      const runner = t.app.get(TransactionRunner);
      const { family, audit } = await runner.runForTenant(tenant.tenantId, async (tx) => ({
        family: await tx
          .selectFrom('refresh_tokens')
          .select(['revoked_at', 'token_hash'])
          .where('user_id', '=', staff.id)
          .execute(),
        audit: await tx
          .selectFrom('audit_log')
          .select('action')
          .where('entity_id', '=', staff.id)
          .where('action', '=', 'auth.refresh_token_reuse_detected')
          .execute(),
      }));
      expect(family).toHaveLength(2);
      expect(family.every((r) => r.revoked_at !== null)).toBe(true);
      // Only hashes are stored.
      expect(family.map((r) => r.token_hash)).not.toContain(first);
      // Both the replayed token and the revoked successor were presented: two alerts.
      expect(audit).toHaveLength(2);
    });

    it('logout revokes the family; unknown tokens are accepted silently', async () => {
      const staff = (await createStaff().expect(201)).body as StaffBody;
      const session = (await login(staff.email).expect(200)).body as SessionBody;
      await request(t.http)
        .post('/v1/auth/logout')
        .send({ refreshToken: session.refreshToken })
        .expect(204);
      await refresh(session.refreshToken).expect(401);
      await request(t.http)
        .post('/v1/auth/logout')
        .send({ refreshToken: 'y'.repeat(43) })
        .expect(204);
    });

    it('a disabled user cannot refresh', async () => {
      const staff = (await createStaff().expect(201)).body as StaffBody;
      const session = (await login(staff.email).expect(200)).body as SessionBody;
      await request(t.http)
        .patch(`/v1/users/${staff.id}`)
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .send({ status: 'DISABLED' })
        .expect(200);
      await refresh(session.refreshToken).expect(401);
    });
  });

  describe('staff management (user:manage)', () => {
    it('lists staff without exposing password hashes', async () => {
      await createStaff().expect(201);
      const res = await request(t.http)
        .get('/v1/users?limit=100')
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThan(4);
      expect(JSON.stringify(res.body)).not.toMatch(/password|failed_login|locked/i);
      expect((res.body as PageBody).items.every((u) => u.role !== 'CUSTOMER')).toBe(true);
    });

    it('pages through rows created within the same millisecond without skipping any', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(((await createStaff().expect(201)).body as StaffBody).id);
      }
      // Same millisecond, different microseconds: finer than the cursor's JS Date.
      await t.app.get(TransactionRunner).runForTenant(tenant.tenantId, async (tx) => {
        for (const [i, id] of ids.entries()) {
          const createdAt = `2020-01-01 00:00:00.000${i + 1}00+00`;
          await sql`UPDATE users SET created_at = ${createdAt}::timestamptz WHERE id = ${id}`.execute(
            tx,
          );
        }
      });

      const seen: string[] = [];
      let cursor: string | null = '';
      while (cursor !== null) {
        const res = await request(t.http)
          .get(`/v1/users?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
          .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
          .expect(200);
        const page = res.body as PageBody;
        seen.push(...page.items.map((u) => u.id));
        cursor = page.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining(ids));
    });

    it('pages through rows sharing the exact same created_at (id breaks the tie)', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(((await createStaff().expect(201)).body as StaffBody).id);
      }
      await t.app.get(TransactionRunner).runForTenant(tenant.tenantId, async (tx) => {
        await sql`UPDATE users SET created_at = '2019-06-01 00:00:00.123456+00'::timestamptz
                   WHERE id = ANY(${ids}::uuid[])`.execute(tx);
      });
      const seen: string[] = [];
      let cursor: string | null = '';
      while (cursor !== null) {
        const res = await request(t.http)
          .get(`/v1/users?limit=1${cursor ? `&cursor=${cursor}` : ''}`)
          .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
          .expect(200);
        const page = res.body as PageBody;
        seen.push(...page.items.map((u) => u.id));
        cursor = page.nextCursor;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining(ids));
    });

    it('treats a cursor with a non-UUID id as the first page', async () => {
      const forged = Buffer.from("v2|2026-01-01T00:00:00.000000Z|x' OR '1'='1").toString(
        'base64url',
      );
      const first = await request(t.http)
        .get('/v1/users?limit=2')
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .expect(200);
      const res = await request(t.http)
        .get(`/v1/users?limit=2&cursor=${forged}`)
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .expect(200);
      expect(res.body.items).toEqual(first.body.items);
    });

    it('demotion takes effect immediately: old access and refresh tokens stop working', async () => {
      const staff = (await createStaff('INSTITUTION_ADMIN').expect(201)).body as StaffBody;
      const session = (await login(staff.email).expect(200)).body as SessionBody;
      const listUsers = (token: string) =>
        request(t.http).get('/v1/users').set('Authorization', `Bearer ${token}`);
      await listUsers(session.accessToken).expect(200);

      await request(t.http)
        .patch(`/v1/users/${staff.id}`)
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .send({ role: 'AUDITOR' })
        .expect(200);

      // The still-unexpired admin token is rejected at once, and cannot be refreshed.
      await listUsers(session.accessToken).expect(401);
      await refresh(session.refreshToken).expect(401);
      // A fresh sign-in carries the new role.
      const demoted = (await login(staff.email).expect(200)).body as SessionBody;
      expect(jwtClaims(demoted.accessToken)).toMatchObject({ role: 'AUDITOR' });
      await listUsers(demoted.accessToken).expect(403);
    });

    it('denies roles without user:manage', async () => {
      await createStaff('AUDITOR', tenant.tokens.CREDIT_OFFICER).expect(403);
      await request(t.http)
        .get('/v1/users')
        .set('Authorization', `Bearer ${tenant.tokens.FINANCE_OFFICER}`)
        .expect(403);
    });

    it('cannot create CUSTOMER accounts or duplicate emails', async () => {
      const res = await createStaff('CUSTOMER').expect(400);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'role' })]),
      );
      const staff = (await createStaff().expect(201)).body as StaffBody;
      const dup = await request(t.http)
        .post('/v1/users')
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .send({
          email: staff.email.toUpperCase(),
          fullName: 'Twin',
          role: 'AUDITOR',
          password: STRONG_PASSWORD,
        })
        .expect(409);
      expect(dup.body.code).toBe('DUPLICATE');
    });

    it('changes role with an audited before/after; admins cannot change themselves', async () => {
      const staff = (await createStaff().expect(201)).body as StaffBody;
      const res = await request(t.http)
        .patch(`/v1/users/${staff.id}`)
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .send({ role: 'FINANCE_OFFICER' })
        .expect(200);
      expect(res.body).toMatchObject({ role: 'FINANCE_OFFICER', status: 'ACTIVE' });

      const audit = await t.app
        .get(TransactionRunner)
        .runForTenant(tenant.tenantId, (tx) =>
          tx
            .selectFrom('audit_log')
            .select(['before_state', 'after_state', 'actor_id'])
            .where('entity_id', '=', staff.id)
            .where('action', '=', 'user.updated')
            .execute(),
        );
      expect(audit).toEqual([
        {
          before_state: { role: 'CREDIT_OFFICER', status: 'ACTIVE' },
          after_state: { role: 'FINANCE_OFFICER', status: 'ACTIVE' },
          actor_id: tenant.userIds.INSTITUTION_ADMIN,
        },
      ]);

      await request(t.http)
        .patch(`/v1/users/${tenant.userIds.INSTITUTION_ADMIN}`)
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .send({ status: 'DISABLED' })
        .expect(403);
      await request(t.http)
        .patch(`/v1/users/${staff.id}`)
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .send({ role: 'CUSTOMER' })
        .expect(400);
      await request(t.http)
        .patch(`/v1/users/${staff.id}`)
        .set('Authorization', `Bearer ${tenant.tokens.INSTITUTION_ADMIN}`)
        .send({})
        .expect(400);
    });

    it('isolates tenants: another institution’s admin sees none of these users (404)', async () => {
      const other = await createTestTenant(t.app);
      const staff = (await createStaff().expect(201)).body as StaffBody;
      const list = await request(t.http)
        .get('/v1/users?limit=100')
        .set('Authorization', `Bearer ${other.tokens.INSTITUTION_ADMIN}`)
        .expect(200);
      expect((list.body as PageBody).items.map((u) => u.id)).not.toContain(staff.id);
      expect(list.body.items).toHaveLength(4);
      await request(t.http)
        .patch(`/v1/users/${staff.id}`)
        .set('Authorization', `Bearer ${other.tokens.INSTITUTION_ADMIN}`)
        .send({ status: 'DISABLED' })
        .expect(404);
    });
  });
});
