import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import request from 'supertest';

import { AwsModule } from '@/common/aws/aws.module';
import { TransactionRunner } from '@/common/database/transaction-runner';
import { REDIS } from '@/common/redis/redis.module';
import { InstitutionsModule } from '@/modules/institutions/institutions.module';

import { createTestTenant, type TestTenant } from '../fixtures/tenants';
import { createTestApp, type TestApp } from '../setup/app';

/** A valid 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface UploadForm {
  url: string;
  fields: Record<string, string>;
  objectKey: string;
}

/** Posts a file to a presigned S3 POST form exactly as a browser would. */
function postToS3(form: UploadForm, body: Buffer, contentType: string): Promise<Response> {
  const data = new FormData();
  for (const [k, v] of Object.entries(form.fields)) data.append(k, v);
  data.append('file', new Blob([body], { type: contentType }), 'logo');
  return fetch(form.url, { method: 'POST', body: data });
}

const brandingBody = (overrides: Record<string, unknown> = {}) => ({
  displayName: 'Acme Health Credit',
  primaryColor: '#112233',
  secondaryColor: '#abcdef',
  supportEmail: 'help@acme.example',
  supportPhone: '+2348012345678',
  websiteUrl: 'https://acme.example',
  locale: 'en-NG',
  expectedVersion: 1,
  ...overrides,
});

describe('Institution profile & white-label branding', () => {
  let t: TestApp;
  let a: TestTenant;
  let b: TestTenant;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const getBranding = (tenant: TestTenant) =>
    request(t.http)
      .get('/v1/institution/branding')
      .set(auth(tenant.tokens.AUDITOR))
      .expect(200)
      .then((r) => r.body as { version: number; logoUrl: string | null });
  const putBranding = (tenant: TestTenant, body: object, token = tenant.tokens.INSTITUTION_ADMIN) =>
    request(t.http).put('/v1/institution/branding').set(auth(token)).send(body);
  const uploadForm = (tenant: TestTenant, contentType = 'image/png') =>
    request(t.http)
      .post('/v1/institution/branding/logo-upload-url')
      .set(auth(tenant.tokens.INSTITUTION_ADMIN))
      .send({ contentType });

  beforeAll(async () => {
    t = await createTestApp([AwsModule, InstitutionsModule]);
    a = await createTestTenant(t.app, { maxAprBps: 3000 });
    b = await createTestTenant(t.app, { currency: 'XOF', lenderType: 'MICROFINANCE_INSTITUTION' });
  });

  afterAll(async () => {
    await t.close();
  });

  describe('GET /v1/institution', () => {
    it('returns the caller’s own institution to any tenant user', async () => {
      const res = await request(t.http)
        .get('/v1/institution')
        .set(auth(a.tokens.CREDIT_OFFICER))
        .expect(200);
      expect(res.body).toMatchObject({
        id: a.tenantId,
        slug: a.slug,
        countryCode: 'NG',
        supportedCurrencies: ['NGN'],
        lenderType: 'MICROFINANCE_BANK',
        maxAprBps: 3000,
        status: 'ACTIVE',
      });
      const other = await request(t.http).get('/v1/institution').set(auth(b.tokens.AUDITOR));
      expect(other.body).toMatchObject({ id: b.tenantId, supportedCurrencies: ['XOF'] });
    });

    it('requires authentication', async () => {
      await request(t.http).get('/v1/institution').expect(401);
    });
  });

  describe('PUT /v1/institution/branding', () => {
    it('updates branding with optimistic concurrency and rejects a stale version', async () => {
      const tenant = await createTestTenant(t.app);
      const current = await getBranding(tenant);
      expect(current.version).toBe(1);

      const ok = await putBranding(tenant, brandingBody()).expect(200);
      expect(ok.body).toMatchObject({
        displayName: 'Acme Health Credit',
        primaryColor: '#112233',
        secondaryColor: '#ABCDEF',
        locale: 'en-NG',
        logoObjectKey: null,
        version: 2,
      });

      const stale = await putBranding(tenant, brandingBody({ displayName: 'Lost update' })).expect(
        409,
      );
      expect(stale.body).toMatchObject({ code: 'CONCURRENT_MODIFICATION', currentVersion: 2 });
      expect((await getBranding(tenant)).version).toBe(2);
    });

    it('records the change in the audit trail and the outbox', async () => {
      const tenant = await createTestTenant(t.app);
      await putBranding(tenant, brandingBody({ displayName: 'Audited' })).expect(200);
      const { audit, events } = await t.app
        .get(TransactionRunner)
        .runForTenant(tenant.tenantId, async (tx) => ({
          audit: await tx
            .selectFrom('audit_log')
            .selectAll()
            .where('action', '=', 'institution.branding_updated')
            .execute(),
          events: await tx
            .selectFrom('outbox_events')
            .selectAll()
            .where('event_type', '=', 'institution.branding_updated')
            .execute(),
        }));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.before_state).toMatchObject({ display_name: `${tenant.slug} Credit` });
      expect(audit[0]?.after_state).toMatchObject({ display_name: 'Audited', version: 2 });
      expect(events).toHaveLength(1);
    });

    it.each([
      ['a non-hex colour', { primaryColor: 'red' }, 'primaryColor'],
      ['a plain-http website', { websiteUrl: 'http://acme.example' }, 'websiteUrl'],
      ['a malformed locale', { locale: 'en_NG' }, 'locale'],
      ['a non-E.164 phone', { supportPhone: '0801 234 5678' }, 'supportPhone'],
      ['an unknown property', { tenantId: randomUUID() }, 'tenantId'],
    ])('rejects %s', async (_label, patch, field) => {
      const res = await putBranding(a, brandingBody(patch)).expect(400);
      expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    });

    it('rejects a logo key belonging to another tenant', async () => {
      const foreignKey = `tenants/${b.tenantId}/branding/logo-${randomUUID()}.png`;
      const res = await putBranding(a, brandingBody({ logoObjectKey: foreignKey })).expect(400);
      expect(res.body.errors).toEqual([expect.objectContaining({ field: 'logoObjectKey' })]);
    });

    it('rejects a well-formed key that was never uploaded', async () => {
      const key = `tenants/${a.tenantId}/branding/logo-${randomUUID()}.png`;
      await putBranding(a, brandingBody({ logoObjectKey: key })).expect(400);
    });

    it('is reserved for institution admins', async () => {
      const res = await putBranding(a, brandingBody(), a.tokens.CREDIT_OFFICER).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });
  });

  describe('logo upload (S3 presigned POST via LocalStack)', () => {
    it('uploads a PNG, attaches it to the branding and serves it via a presigned URL', async () => {
      const tenant = await createTestTenant(t.app);
      const form = (await uploadForm(tenant).expect(201)).body as UploadForm;
      expect(form.objectKey).toMatch(
        new RegExp(`^tenants/${tenant.tenantId}/branding/logo-[0-9a-f-]{36}\\.png$`),
      );
      expect(form.fields['Content-Type']).toBe('image/png');

      const upload = await postToS3(form, PNG, 'image/png');
      expect(upload.status).toBe(204);

      const res = await putBranding(tenant, brandingBody({ logoObjectKey: form.objectKey })).expect(
        200,
      );
      expect(res.body.logoObjectKey).toBe(form.objectKey);
      const logoUrl = res.body.logoUrl as string;
      expect(logoUrl).toContain('X-Amz-Signature=');
      expect(logoUrl).toContain('X-Amz-Expires=3600');

      const download = await fetch(logoUrl);
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer()).equals(PNG)).toBe(true);
    });

    it('rejects a file larger than 1 MiB', async () => {
      const form = (await uploadForm(a).expect(201)).body as UploadForm;
      const upload = await postToS3(form, Buffer.alloc(1024 * 1024 + 1, 1), 'image/png');
      expect(upload.status).toBe(400);
      expect(await upload.text()).toContain('EntityTooLarge');
    });

    it('rejects an upload whose Content-Type differs from the signed policy', async () => {
      const form = (await uploadForm(a).expect(201)).body as UploadForm;
      const tampered = { ...form, fields: { ...form.fields, 'Content-Type': 'text/html' } };
      const upload = await postToS3(tampered, PNG, 'text/html');
      expect(upload.status).toBe(403);
    });

    it('does not offer SVG (stored-XSS risk) or other types', async () => {
      await uploadForm(a, 'image/svg+xml').expect(400);
      await uploadForm(a, 'text/html').expect(400);
    });

    it('is reserved for institution admins', async () => {
      await request(t.http)
        .post('/v1/institution/branding/logo-upload-url')
        .set(auth(a.tokens.AUDITOR))
        .send({ contentType: 'image/png' })
        .expect(403);
    });
  });

  describe('GET /v1/institutions/:slug/branding (public)', () => {
    const publicBranding = (slug: string) =>
      request(t.http).get(`/v1/institutions/${slug}/branding`);

    it('returns branding without authentication and without the tenant id', async () => {
      const res = await publicBranding(b.slug).expect(200);
      expect(res.body).toEqual({
        slug: b.slug,
        displayName: `${b.slug} Credit`,
        primaryColor: '#0B5FFF',
        secondaryColor: '#111827',
        locale: 'en-NG',
        supportEmail: null,
        supportPhone: null,
        websiteUrl: null,
        logoUrl: null,
      });
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(JSON.stringify(res.body)).not.toContain(b.tenantId);
    });

    it('returns 404 for unknown and malformed slugs', async () => {
      const unknown = await publicBranding('no-such-lender').expect(404);
      expect(unknown.body.code).toBe('NOT_FOUND');
      await publicBranding('NOT_A_SLUG').expect(404);
    });

    it('returns 404 for a suspended institution', async () => {
      const tenant = await createTestTenant(t.app);
      await t.app
        .get(TransactionRunner)
        .asPlatformAdmin((tx) =>
          tx
            .updateTable('institutions')
            .set({ status: 'SUSPENDED' })
            .where('id', '=', tenant.tenantId)
            .execute(),
        );
      await publicBranding(tenant.slug).expect(404);
    });

    it('serves from the Redis cache and invalidates it when branding changes', async () => {
      const tenant = await createTestTenant(t.app);
      const redis = t.app.get<Redis>(REDIS);
      const cacheKey = `branding:public:v1:${tenant.slug}`;

      await publicBranding(tenant.slug).expect(200);
      expect(await redis.ttl(cacheKey)).toBeGreaterThan(0);

      // A cached document is served as-is (proves the read path uses the cache).
      const cached = JSON.parse((await redis.get(cacheKey)) ?? '{}') as Record<string, unknown>;
      await redis.set(cacheKey, JSON.stringify({ ...cached, displayName: 'From cache' }), 'EX', 60);
      expect((await publicBranding(tenant.slug).expect(200)).body.displayName).toBe('From cache');

      await putBranding(tenant, brandingBody({ displayName: 'Rebranded', locale: 'fr-SN' })).expect(
        200,
      );
      expect(await redis.exists(cacheKey)).toBe(0);
      const fresh = await publicBranding(tenant.slug).expect(200);
      expect(fresh.body).toMatchObject({ displayName: 'Rebranded', locale: 'fr-SN' });
    });
  });
});
