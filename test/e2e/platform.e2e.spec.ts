import { randomUUID } from 'node:crypto';

import request from 'supertest';

import { TransactionRunner } from '@/common/database/transaction-runner';
import {
  TENANT_DIRECTORY,
  type TenantDirectory,
} from '@/modules/directory/application/tenant-directory.port';

import { createTestTenant } from '../fixtures/tenants';
import {
  createPlatformAdmin,
  IDENTITY_MODULES,
  jwtClaims,
  type PageBody,
  type SessionBody,
  STRONG_PASSWORD,
} from '../fixtures/identity';
import { createTestApp, type TestApp } from '../setup/app';

describe('Platform administration', () => {
  let t: TestApp;
  let admin: { email: string; password: string };
  let platformToken: string;

  const login = (email: string, password: string) =>
    request(t.http).post('/v1/platform/auth/login').send({ email, password });

  const registrationBody = (overrides: Record<string, unknown> = {}) => {
    const slug = `mfb-${randomUUID().slice(0, 8)}`;
    return {
      slug,
      legalName: `${slug} Microfinance Bank Ltd`,
      countryCode: 'NG',
      defaultCurrency: 'NGN',
      supportedCurrencies: ['NGN', 'USD'],
      lenderType: 'MICROFINANCE_BANK',
      maxAprBps: 3600,
      homeRegion: 'af-south-1',
      branding: { displayName: 'Lagos Health Credit', primaryColor: '#123456' },
      firstAdmin: { fullName: 'Ada Obi', email: `Admin@${slug}.test`, password: STRONG_PASSWORD },
      ...overrides,
    };
  };

  const register = (body: unknown, token = platformToken) =>
    request(t.http)
      .post('/v1/platform/institutions')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  beforeAll(async () => {
    t = await createTestApp(IDENTITY_MODULES);
    admin = await createPlatformAdmin(t.app);
    platformToken = ((await login(admin.email, admin.password).expect(200)).body as SessionBody)
      .accessToken;
  });

  afterAll(async () => {
    await t.close();
  });

  describe('sign-in', () => {
    it('issues a platform access token and a refresh token', async () => {
      const res = await login(admin.email.toUpperCase(), admin.password).expect(200);
      expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.refreshToken).toHaveLength(43);
      expect(jwtClaims((res.body as SessionBody).accessToken)).toMatchObject({
        aud: 'platform',
      });
    });

    it('returns the same INVALID_CREDENTIALS for an unknown email and a wrong password', async () => {
      const unknown = await login('nobody@platform.test', STRONG_PASSWORD).expect(401);
      const wrong = await login(admin.email, 'Wrong-Password-1').expect(401);
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      expect(unknown.body.detail).toBe(wrong.body.detail);
    });

    it('locks the account after 5 consecutive failures, even for the right password', async () => {
      const victim = await createPlatformAdmin(t.app);
      for (let i = 0; i < 4; i++) await login(victim.email, 'Wrong-Password-1').expect(401);
      // Locked looks exactly like a wrong password (no account-existence oracle).
      const fifth = await login(victim.email, 'Wrong-Password-1').expect(401);
      expect(fifth.body.code).toBe('INVALID_CREDENTIALS');
      const right = await login(victim.email, victim.password).expect(401);
      expect(right.body).toMatchObject({ code: 'INVALID_CREDENTIALS', detail: fifth.body.detail });
    });

    it('resets the failure counter after a successful sign-in', async () => {
      const user = await createPlatformAdmin(t.app);
      for (let i = 0; i < 4; i++) await login(user.email, 'Wrong-Password-1').expect(401);
      await login(user.email, user.password).expect(200);
      for (let i = 0; i < 4; i++) await login(user.email, 'Wrong-Password-1').expect(401);
      await login(user.email, user.password).expect(200);
    });
  });

  describe('refresh rotation', () => {
    const refresh = (refreshToken: string) =>
      request(t.http).post('/v1/platform/auth/refresh').send({ refreshToken });

    it('rotates the token and detects reuse by revoking the whole family', async () => {
      const first = ((await login(admin.email, admin.password).expect(200)).body as SessionBody)
        .refreshToken;
      const second = ((await refresh(first).expect(200)).body as SessionBody).refreshToken;
      expect(second).not.toBe(first);

      const reuse = await refresh(first).expect(401);
      expect(reuse.body.code).toBe('INVALID_REFRESH_TOKEN');
      // The legitimate successor was revoked with the family.
      await refresh(second).expect(401);
    });

    it('rejects an unknown token', async () => {
      await refresh('x'.repeat(43)).expect(401);
    });
  });

  describe('institution registration', () => {
    it('creates institution, branding, chart of accounts and a first admin who can sign in', async () => {
      const body = registrationBody();
      const res = await register(body).expect(201);
      expect(res.body).toMatchObject({
        slug: body.slug,
        status: 'ACTIVE',
        supportedCurrencies: ['NGN', 'USD'],
        maxAprBps: 3600,
        timezone: 'Africa/Lagos',
        homeRegion: 'af-south-1',
        branding: { displayName: 'Lagos Health Credit', primaryColor: '#123456', locale: 'en-NG' },
        firstAdmin: { email: `admin@${body.slug}.test`, role: 'INSTITUTION_ADMIN' },
        ledgerAccountsCreated: 18,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);

      const tenantId = (res.body as { id: string }).id;
      const runner = t.app.get(TransactionRunner);
      const { accounts, audit, events } = await runner.runForTenant(tenantId, async (tx) => ({
        accounts: await tx.selectFrom('ledger_accounts').select(['code', 'currency']).execute(),
        audit: await tx.selectFrom('audit_log').select(['action', 'actor_type']).execute(),
        events: await tx.selectFrom('outbox_events').select('event_type').execute(),
      }));
      expect(accounts).toHaveLength(18);
      expect(new Set(accounts.map((a) => a.currency))).toEqual(new Set(['NGN', 'USD']));
      expect(accounts.map((a) => a.code)).toContain('1100');
      expect(audit).toEqual([{ action: 'institution.registered', actor_type: 'PLATFORM_ADMIN' }]);
      expect(events).toEqual([{ event_type: 'institution.registered' }]);

      const tenantLogin = await request(t.http)
        .post('/v1/auth/login')
        .send({
          institutionSlug: body.slug,
          email: body.firstAdmin.email,
          password: STRONG_PASSWORD,
        })
        .expect(200);
      const users = await request(t.http)
        .get('/v1/users')
        .set('Authorization', `Bearer ${(tenantLogin.body as SessionBody).accessToken}`)
        .expect(200);
      expect(users.body.items).toHaveLength(1);
    });

    it('rejects a duplicate slug with 409 DUPLICATE', async () => {
      const body = registrationBody();
      await register(body).expect(201);
      const res = await register({
        ...registrationBody(),
        slug: body.slug,
      }).expect(409);
      expect(res.body.code).toBe('DUPLICATE');
    });

    it('rejects a slug homed in another cell (global reservation) with 409 DUPLICATE', async () => {
      const body = registrationBody();
      await t.app.get<TenantDirectory>(TENANT_DIRECTORY).upsert({
        slug: body.slug,
        institutionId: randomUUID(),
        homeRegion: 'eu-west-3',
        apiBaseUrl: 'http://cell-b.test',
        status: 'ACTIVE',
        version: 1,
        updatedAt: new Date().toISOString(),
      });
      const res = await register(body).expect(409);
      expect(res.body.code).toBe('DUPLICATE');
      const local = await t.app
        .get(TransactionRunner)
        .asPlatformAdmin((tx) =>
          tx.selectFrom('institutions').select('id').where('slug', '=', body.slug).execute(),
        );
      expect(local).toEqual([]);
    });

    it('never lets a projection overwrite a slug owned by another cell or institution', async () => {
      const directory = t.app.get<TenantDirectory>(TENANT_DIRECTORY);
      const slug = `owned-${randomUUID().slice(0, 8)}`;
      const owner = {
        slug,
        institutionId: randomUUID(),
        homeRegion: 'eu-west-3',
        apiBaseUrl: 'http://cell-b.test',
        status: 'ACTIVE' as const,
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      await expect(directory.upsert(owner)).resolves.toBe('applied');
      await expect(
        directory.upsert({
          ...owner,
          institutionId: randomUUID(),
          homeRegion: 'af-south-1',
          apiBaseUrl: 'http://cell-af-south-1.test',
          version: 999,
        }),
      ).resolves.toBe('stale');
      await expect(
        directory.upsert({ ...owner, institutionId: randomUUID(), version: 2 }),
      ).resolves.toBe('stale');
      await expect(directory.upsert({ ...owner, status: 'SUSPENDED', version: 2 })).resolves.toBe(
        'applied',
      );
      await expect(directory.get(slug)).resolves.toMatchObject({
        institutionId: owner.institutionId,
        status: 'SUSPENDED',
      });
    });

    it('keeps an unprojected slug reservation invisible to directory lookups', async () => {
      const body = registrationBody();
      await register(body).expect(201);
      const directory = t.app.get<TenantDirectory>(TENANT_DIRECTORY);
      // Not projected yet (no worker in this test): only a PENDING reservation exists.
      await expect(directory.get(body.slug)).resolves.toBeUndefined();
      await request(t.http).get(`/v1/directory/institutions/${body.slug}`).expect(404);
    });

    it('validates currencies, password strength and unknown fields', async () => {
      const unsupported = await register(
        registrationBody({ supportedCurrencies: ['NGN', 'ZZZ'] }),
      ).expect(422);
      expect(unsupported.body.code).toBe('UNSUPPORTED_CURRENCY');

      await register(registrationBody({ defaultCurrency: 'XOF' })).expect(400);

      const weak = await register(
        registrationBody({
          firstAdmin: { fullName: 'Ada', email: 'a@b.test', password: 'short' },
        }),
      ).expect(400);
      expect(weak.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'firstAdmin.password' })]),
      );

      await register(registrationBody({ status: 'SUSPENDED' })).expect(400);
      await register(registrationBody({ homeRegion: 'Lagos' })).expect(400);
    });

    it('rejects an institution homed in another region with 422 WRONG_CELL', async () => {
      const res = await register(registrationBody({ homeRegion: 'eu-west-1' })).expect(422);
      expect(res.body).toMatchObject({
        code: 'WRONG_CELL',
        homeRegion: 'eu-west-1',
        cellRegion: 'af-south-1',
      });
    });

    it('is reserved for platform administrators', async () => {
      const tenant = await createTestTenant(t.app);
      await register(registrationBody(), tenant.tokens.INSTITUTION_ADMIN).expect(403);
      await request(t.http).post('/v1/platform/institutions').send(registrationBody()).expect(401);
    });
  });

  describe('listing and suspension', () => {
    it('lists institutions with cursor pagination', async () => {
      await register(registrationBody()).expect(201);
      await register(registrationBody()).expect(201);
      const page1 = await request(t.http)
        .get('/v1/platform/institutions?limit=1')
        .set('Authorization', `Bearer ${platformToken}`)
        .expect(200);
      expect(page1.body.items).toHaveLength(1);
      expect(page1.body.nextCursor).toEqual(expect.any(String));
      const page2 = await request(t.http)
        .get(
          `/v1/platform/institutions?limit=1&cursor=${String((page1.body as PageBody).nextCursor)}`,
        )
        .set('Authorization', `Bearer ${platformToken}`)
        .expect(200);
      expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
      expect(page1.body.items[0].homeRegion).toBe('af-south-1');
    });

    it('suspends an institution: audited, sign-in and refresh rejected; reactivation restores', async () => {
      const body = registrationBody();
      const { id } = (await register(body).expect(201)).body as { id: string };
      const credentials = {
        institutionSlug: body.slug,
        email: body.firstAdmin.email,
        password: STRONG_PASSWORD,
      };
      const session = (await request(t.http).post('/v1/auth/login').send(credentials).expect(200))
        .body;
      const access = (session as SessionBody).accessToken;
      const listUsers = () =>
        request(t.http).get('/v1/users').set('Authorization', `Bearer ${access}`);
      await listUsers().expect(200);
      // Prime the public branding cache.
      await request(t.http).get(`/v1/institutions/${body.slug}/branding`).expect(200);

      const setStatus = (status: string) =>
        request(t.http)
          .patch(`/v1/platform/institutions/${id}/status`)
          .set('Authorization', `Bearer ${platformToken}`)
          .send({ status, reason: 'Regulatory review' });

      expect((await setStatus('SUSPENDED').expect(200)).body.status).toBe('SUSPENDED');

      // Immediate: the outstanding access token is refused, and the public branding cache
      // was invalidated (404, never publicly cacheable).
      const blocked = await listUsers().expect(403);
      expect(blocked.body.code).toBe('INSTITUTION_SUSPENDED');
      const branding = await request(t.http)
        .get(`/v1/institutions/${body.slug}/branding`)
        .expect(404);
      expect(branding.headers['cache-control']).toBeUndefined();

      const denied = await request(t.http).post('/v1/auth/login').send(credentials).expect(403);
      expect(denied.body.code).toBe('INSTITUTION_SUSPENDED');
      // Wrong password on a suspended tenant still looks like any bad credential.
      await request(t.http)
        .post('/v1/auth/login')
        .send({ ...credentials, password: 'Wrong-Password-1' })
        .expect(401);
      await request(t.http)
        .post('/v1/auth/refresh')
        .send({ refreshToken: (session as SessionBody).refreshToken })
        .expect(401);

      const audit = await t.app
        .get(TransactionRunner)
        .runForTenant(id, (tx) =>
          tx
            .selectFrom('audit_log')
            .select(['action', 'before_state', 'after_state'])
            .where('action', '=', 'institution.status_changed')
            .execute(),
        );
      expect(audit).toEqual([
        {
          action: 'institution.status_changed',
          before_state: { status: 'ACTIVE' },
          after_state: { status: 'SUSPENDED', reason: 'Regulatory review' },
        },
      ]);

      await setStatus('ACTIVE').expect(200);
      await request(t.http).post('/v1/auth/login').send(credentials).expect(200);
      // Tokens issued before the suspension stay dead after reactivation.
      await listUsers().expect(401);
    });

    it('returns 404 for an unknown institution and 400 for a bad status', async () => {
      await request(t.http)
        .patch(`/v1/platform/institutions/${randomUUID()}/status`)
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ status: 'SUSPENDED', reason: 'x-test' })
        .expect(404);
      await request(t.http)
        .patch(`/v1/platform/institutions/${randomUUID()}/status`)
        .set('Authorization', `Bearer ${platformToken}`)
        .send({ status: 'DELETED', reason: 'x-test' })
        .expect(400);
    });
  });
});
