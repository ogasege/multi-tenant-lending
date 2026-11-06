import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import pg from 'pg';
import request from 'supertest';
import { inject } from 'vitest';

import type { DemoApplicantsFile } from '@/cli/demo-applicants';
import { BUILT_IN_LENDERS, CHECKOUT_PRODUCT_CODE } from '@/cli/seed-lenders';
import { seed, type SeedSummary } from '@/cli/seed';

import { createTestApp } from '../setup/app';
import { TEST_DB } from '../setup/postgres';

interface ProductItem {
  id: string;
  code: string;
  currentVersion: number;
  terms: { originationFee: { treatment: string } } & Record<string, unknown>;
}

/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Signs a seeded account in with the password the first seed run printed. */
async function signIn(
  http: Parameters<typeof request>[0],
  summary: SeedSummary,
  slug: string,
  role: string,
): Promise<string> {
  const account = summary.credentials.find((c) => c.lender === slug && c.role === role)!;
  const res = await request(http)
    .post('/v1/auth/login')
    .send({ institutionSlug: slug, email: account.email, password: account.password })
    .expect(200);
  return (res.body as { accessToken: string }).accessToken;
}

/** The checkout product as the institution admin lists it. */
async function checkoutProduct(
  http: Parameters<typeof request>[0],
  token: string,
): Promise<ProductItem> {
  const res = await request(http)
    .get('/v1/loan-products?limit=100')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);
  return (res.body as { items: ProductItem[] }).items.find(
    (p) => p.code === CHECKOUT_PRODUCT_CODE,
  )!;
}

describe('npm run seed', () => {
  const env = inject('env');

  it('seeds the lenders of this cell through the API, idempotently', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'seed-'));
    const logo = path.join(dir, 'eko.png');
    await writeFile(logo, PNG);
    const lenders = BUILT_IN_LENDERS.map((l) =>
      l.slug === 'eko-medicredit' ? { ...l, logoPath: logo } : l,
    );
    Object.assign(process.env, env);
    const lines: string[] = [];
    const applicantsFile = path.join(dir, 'demo-applicants.json');
    const run = () =>
      seed({
        env: { ...env, SEED_PLATFORM_ADMIN_EMAIL: 'seed-ops@platform.example' },
        out: (l) => lines.push(l),
        lenders,
        demoApplicantsFile: applicantsFile,
      });

    const first = await run();
    expect(first.seeded).toEqual(['eko-medicredit', 'arewa-pharmafinance', 'delta-carelend']);
    expect(first.skippedOtherCells).toEqual(['teranga-sante']);
    // Platform admin + 3 lenders × (4 staff + 2 customers), each with a fresh password.
    expect(first.credentials).toHaveLength(1 + 3 * 6);
    expect(first.credentials.every((c) => c.password !== undefined)).toBe(true);
    expect(lines.join('\n')).toContain('LOCAL ONLY');
    expect(lines.join('\n')).toContain('Demo applicants');
    expect(first.demoApplicants).toHaveLength(3 * 5);
    const file = JSON.parse(await readFile(applicantsFile, 'utf8')) as DemoApplicantsFile;
    expect(Object.keys(file.lenders).sort()).toEqual([...first.seeded].sort());
    expect(file.lenders['eko-medicredit']?.cellRegion).toBe('af-south-1');

    // An older seed's checkout product (fee DEDUCTED) is brought back in line by a re-run.
    // Each app is closed before the next seed run: closing a Nest app resets nestjs-cls
    // process-wide, so no test app may outlive a seed run.
    let checkout: ProductItem;
    let app = await createTestApp();
    try {
      const adminToken = await signIn(app.http, first, 'eko-medicredit', 'INSTITUTION_ADMIN');
      checkout = await checkoutProduct(app.http, adminToken);
      expect(checkout.terms.originationFee.treatment).toBe('CAPITALISED');
      const { versionId: _v, version: _n, dayCount: _d, createdAt: _c, ...terms } = checkout.terms;
      await request(app.http)
        .post(`/v1/loan-products/${checkout.id}/versions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          expectedVersion: checkout.currentVersion,
          terms: {
            ...terms,
            originationFee: { ...checkout.terms.originationFee, treatment: 'DEDUCTED' },
          },
        })
        .expect(201);
    } finally {
      await app.close();
    }

    const second = await run();
    expect(second.seeded).toEqual(first.seeded);
    expect(second.credentials.every((c) => c.password === undefined)).toBe(true);
    expect(second.demoApplicants).toEqual(first.demoApplicants);

    app = await createTestApp();
    try {
      const adminToken = await signIn(app.http, first, 'eko-medicredit', 'INSTITUTION_ADMIN');
      const resynced = await checkoutProduct(app.http, adminToken);
      expect(resynced.terms.originationFee.treatment).toBe('CAPITALISED');
      expect(resynced.currentVersion).toBe(checkout.currentVersion + 2);

      // Every demo applicant gets exactly the documented decision from the real API.
      const creditToken = await signIn(app.http, first, 'eko-medicredit', 'CREDIT_OFFICER');
      for (const applicant of first.demoApplicants.filter((a) => a.lender === 'eko-medicredit')) {
        const registered = await request(app.http)
          .post('/v1/institutions/eko-medicredit/customers/register')
          .send({ ...applicant.registration, password: 'Demo-Applicant-Pass-1' })
          .expect(201);
        const customerToken = (registered.body as { tokens: { accessToken: string } }).tokens
          .accessToken;
        const application = await request(app.http)
          .post('/v1/loan-applications')
          .set('Authorization', `Bearer ${customerToken}`)
          .set('Idempotency-Key', `seed-${randomUUID()}`)
          .send({
            productId: resynced.id,
            principal: applicant.request.principal,
            term: applicant.request.term,
            payee: { type: 'VENDOR', name: 'Medisource Distributors Ltd', account: '0123456789' },
            // A demo order of the mock procurement platform (payable to its NGN supplier).
            externalOrderReference: `ORD-2026-${Date.now()}`,
          });
        expect(application.status, JSON.stringify(application.body)).toBe(201);
        const assessed = await request(app.http)
          .post(`/v1/loan-applications/${(application.body as { id: string }).id}/assess`)
          .set('Authorization', `Bearer ${creditToken}`)
          .expect(200);
        expect(assessed.body.decision, String(applicant.registration.nationalId)).toBe(
          applicant.expectedDecision,
        );
      }
    } finally {
      await app.close();
    }

    // Inspect as lending_worker (worker_all policy: sees every tenant): nothing duplicated.
    const worker = new pg.Client({
      host: env.DATABASE_HOST,
      port: Number(env.DATABASE_PORT),
      database: env.DATABASE_NAME,
      user: 'lending_worker',
      password: TEST_DB.workerPassword,
    });
    await worker.connect();
    try {
      const { rows } = await worker.query<{
        slug: string;
        users: string;
        products: string;
        customers: string;
        logo: string | null;
        primary_color: string;
      }>(
        `SELECT i.slug,
                (SELECT count(*) FROM users u WHERE u.tenant_id = i.id)::text AS users,
                (SELECT count(*) FROM loan_products p WHERE p.tenant_id = i.id)::text AS products,
                (SELECT count(*) FROM customers c WHERE c.tenant_id = i.id)::text AS customers,
                b.logo_object_key AS logo, b.primary_color
           FROM institutions i JOIN institution_branding b ON b.tenant_id = i.id
          WHERE i.slug = ANY($1) ORDER BY i.slug`,
        [first.seeded],
      );
      expect(rows.map((r) => [r.slug, r.users, r.products, r.customers])).toEqual([
        ['arewa-pharmafinance', '6', '2', '2'],
        ['delta-carelend', '6', '2', '2'],
        // + the 5 demo applicants this test signed up (they are users and customers).
        ['eko-medicredit', '11', '2', '7'],
      ]);
      expect(rows.find((r) => r.slug === 'eko-medicredit')?.logo).toMatch(/logo-.*\.png$/);
      expect(rows.find((r) => r.slug === 'delta-carelend')?.primary_color).toBe('#1D4ED8');
    } finally {
      await worker.end();
    }
  });

  it('refuses to run against production without the explicit override', async () => {
    await expect(seed({ env: { NODE_ENV: 'production' }, out: () => undefined })).rejects.toThrow(
      /production/,
    );
  });
});
