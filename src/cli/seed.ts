/*
 * Demo data loader (`npm run seed`). Idempotent: every step checks for, or tolerates, what a
 * previous run created. It goes through the REAL API in-process: the Nest app listens on an
 * ephemeral loopback port and the seed calls it over HTTP with tokens it mints for the
 * accounts it owns, so validation, RBAC, audit and outbox apply exactly as for any client.
 *
 * It seeds the CELL its environment points at (DATABASE_*, REDIS_URL, CELL_REGION, ...) and
 * only the demo lenders homed in that cell's region; run it once per cell (e.g. with the EU
 * cell's DATABASE_NAME / CELL_REGION / CELL_API_BASE_URL) to seed the others.
 */
import 'reflect-metadata';

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { TokenService } from '../common/auth/token.service';
import type { UserRole } from '../common/database/schema';
import { TransactionRunner } from '../common/database/transaction-runner';
import { ConflictError } from '../common/errors/app-error';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { DirectoryReconciler } from '../modules/directory/application/directory-reconciler';
import { CreatePlatformAdmin } from '../modules/platform/admins/create-platform-admin.use-case';

import {
  type CheckoutTerms,
  type DemoApplicant,
  demoApplicantsTable,
  findDemoApplicants,
  writeDemoApplicantsFile,
} from './demo-applicants';
import {
  CHECKOUT_PRODUCT_CODE,
  type DemoLender,
  demoCustomers,
  demoProducts,
  loadLenders,
} from './seed-lenders';

const STAFF: readonly { role: Exclude<UserRole, 'CUSTOMER'>; local: string; name: string }[] = [
  { role: 'INSTITUTION_ADMIN', local: 'admin', name: 'Adaeze Okafor' },
  { role: 'CREDIT_OFFICER', local: 'credit', name: 'Chidi Okeke' },
  { role: 'FINANCE_OFFICER', local: 'finance', name: 'Funke Adeyemi' },
  { role: 'AUDITOR', local: 'audit', name: 'Ibrahim Musa' },
];

const LOGO_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

interface CredentialRow {
  lender: string;
  role: string;
  email: string;
  password: string | undefined;
}

export interface SeedOptions {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  /** Overrides the lender catalogue (tests). */
  lenders?: DemoLender[];
  /**
   * Where to write demo-applicants.json. Default: `SEED_DEMO_APPLICANTS_FILE`, else next to
   * the front-end catalogue (lenders.json) when that is the source; `false` disables it.
   */
  demoApplicantsFile?: string | false;
}

export interface SeedSummary {
  cellRegion: string;
  seeded: string[];
  skippedOtherCells: string[];
  credentials: CredentialRow[];
  /** Applicants with a known credit decision per seeded lender (see demo-applicants.ts). */
  demoApplicants: DemoApplicant[];
  /** File the demo applicants were written to, if any. */
  demoApplicantsFile?: string;
}

/** A loan product as listed by `GET /v1/loan-products` (the fields the seed reads). */
interface ProductItem {
  id: string;
  code: string;
  currentVersion: number;
  terms: {
    currency: string;
    minPrincipal: string;
    minTerm: number;
    annualInterestRateBps: number;
    originationFee: {
      type: CheckoutTerms['originationFee']['type'];
      value: string;
      treatment: string;
    };
    maxDtiBps?: number;
    minCreditScore?: number;
  };
}

/** Refuses production unless explicitly allowed (demo data must never land there by accident). */
export function assertSeedAllowed(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production' && env.SEED_ALLOW_PRODUCTION !== 'true') {
    throw new Error('Refusing to seed with NODE_ENV=production (set SEED_ALLOW_PRODUCTION=true)');
  }
}

/** A password meeting the policy (12+ chars, upper, lower, digit), from a CSPRNG. */
export function generatePassword(): string {
  return `Seed-${randomBytes(18).toString('base64url')}-9aZ`;
}

class SeedHttp {
  constructor(private readonly baseUrl: string) {}

  /** POST; the JSON body, or `undefined` when the resource already exists (409). */
  async create<T>(urlPath: string, body: unknown, token?: string): Promise<T | undefined> {
    const res = await this.call('POST', urlPath, body, token);
    if (res.status === 409) return undefined;
    return this.json<T>(res, 'POST', urlPath);
  }

  async get<T>(urlPath: string, token: string): Promise<T> {
    return this.json<T>(await this.call('GET', urlPath, undefined, token), 'GET', urlPath);
  }

  async put<T>(urlPath: string, body: unknown, token: string): Promise<T> {
    return this.json<T>(await this.call('PUT', urlPath, body, token), 'PUT', urlPath);
  }

  /** One request; a 429 (the API's per-IP auth limit) is retried after `Retry-After`. */
  private async call(
    method: string,
    urlPath: string,
    body: unknown,
    token?: string,
  ): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${this.baseUrl}${urlPath}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status !== 429 || attempt >= 3) return res;
      const waitSeconds = Math.min(Number(res.headers.get('retry-after') ?? '5') || 5, 60);
      await res.arrayBuffer();
      await sleep(waitSeconds * 1000);
    }
  }

  private async json<T>(res: Response, method: string, urlPath: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${urlPath} failed with ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  }
}

interface Branding {
  displayName: string;
  primaryColor: string;
  secondaryColor: string;
  supportEmail: string | null;
  supportPhone: string | null;
  websiteUrl: string | null;
  locale: string;
  logoObjectKey: string | null;
  version: number;
}

export async function seed({
  env,
  out,
  lenders: override,
  demoApplicantsFile,
}: SeedOptions): Promise<SeedSummary> {
  assertSeedAllowed(env);
  const local = env.NODE_ENV !== 'production';
  const passwordFor = (variable: string): string => {
    const fromEnv = env[variable];
    if (fromEnv) return fromEnv;
    if (!local) throw new Error(`${variable} is required outside local environments`);
    return generatePassword();
  };

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'],
  });
  const config = app.get<Env>(APP_CONFIG);
  configureApp(app, config);
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const http = new SeedHttp(`http://127.0.0.1:${port}`);
  const runner = app.get(TransactionRunner);
  const tokens = app.get(TokenService);

  const catalogue = override ? { lenders: override, source: 'options' } : loadLenders();
  const mine = catalogue.lenders.filter((l) => l.homeRegion === config.CELL_REGION);
  const summary: SeedSummary = {
    cellRegion: config.CELL_REGION,
    seeded: [],
    skippedOtherCells: catalogue.lenders.filter((l) => !mine.includes(l)).map((l) => l.slug),
    credentials: [],
    demoApplicants: [],
  };
  const applicantsFile =
    demoApplicantsFile === false
      ? undefined
      : (demoApplicantsFile ??
        env.SEED_DEMO_APPLICANTS_FILE ??
        (override || catalogue.source === 'built-in list'
          ? undefined
          : path.join(path.dirname(catalogue.source), 'demo-applicants.json')));

  try {
    // 1. Platform admin, through the operator use case (no HTTP path can create one).
    const adminEmail = (env.SEED_PLATFORM_ADMIN_EMAIL ?? 'ops@platform.example').toLowerCase();
    const adminPassword = passwordFor('SEED_PLATFORM_ADMIN_PASSWORD');
    let adminCreated = true;
    try {
      await app.get(CreatePlatformAdmin).execute({
        email: adminEmail,
        fullName: 'Platform Operations',
        password: adminPassword,
      });
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      adminCreated = false;
    }
    summary.credentials.push({
      lender: '(platform)',
      role: 'PLATFORM_ADMIN',
      email: adminEmail,
      password: adminCreated ? adminPassword : undefined,
    });
    const admin = await runner.asPlatformAuth((tx) =>
      tx
        .selectFrom('platform_admins')
        .select('id')
        .where((eb) => eb(eb.fn('lower', ['email']), '=', adminEmail))
        .executeTakeFirstOrThrow(),
    );
    const platformToken = tokens.issueAccessToken({
      kind: 'PLATFORM_ADMIN',
      id: admin.id,
    }).accessToken;

    const staffPassword = passwordFor('SEED_STAFF_PASSWORD');
    const customerPassword = passwordFor('SEED_CUSTOMER_PASSWORD');

    for (const lender of mine) {
      await seedLender(lender);
      summary.seeded.push(lender.slug);
    }

    // Project every institution of this cell into the global tenant directory.
    const directory = await app.get(DirectoryReconciler).projectPendingInstitutions();

    out(`Cell ${config.CELL_REGION}: lenders from ${catalogue.source}`);
    out(`  seeded: ${summary.seeded.join(', ') || '(none homed in this cell)'}`);
    if (summary.skippedOtherCells.length > 0) {
      out(`  other cells (run the seed there): ${summary.skippedOtherCells.join(', ')}`);
    }
    out(`  tenant directory: ${directory.applied} applied, ${directory.stale} already current`);
    out('');
    out(credentialsTable(summary.credentials, local));
    if (summary.demoApplicants.length > 0) {
      out('');
      out(demoApplicantsTable(summary.demoApplicants));
      if (applicantsFile) {
        await writeDemoApplicantsFile(applicantsFile, config.CELL_REGION, summary.demoApplicants);
        summary.demoApplicantsFile = applicantsFile;
        out(`  written to ${applicantsFile}`);
      }
    }
    return summary;

    async function seedLender(lender: DemoLender): Promise<void> {
      const staffEmail = (localPart: string) => `${localPart}@${lender.slug}.example`;

      // 2. Platform registration with the first admin and initial branding.
      const registered = await http.create(
        '/v1/platform/institutions',
        {
          slug: lender.slug,
          legalName: lender.legalName,
          countryCode: lender.countryCode,
          defaultCurrency: lender.currency,
          supportedCurrencies: [lender.currency],
          lenderType: lender.lenderType,
          ...(lender.maxAprBps ? { maxAprBps: lender.maxAprBps } : {}),
          homeRegion: lender.homeRegion,
          timezone: lender.timezone,
          branding: {
            displayName: lender.displayName,
            primaryColor: lender.primaryColor,
            secondaryColor: lender.secondaryColor,
            locale: lender.locale,
          },
          firstAdmin: {
            fullName: STAFF[0]?.name ?? 'Institution Admin',
            email: staffEmail('admin'),
            password: staffPassword,
          },
        },
        platformToken,
      );
      const institution = await runner.resolveInstitution(lender.slug);
      if (!institution) throw new Error(`Institution ${lender.slug} is missing after registration`);
      const tenantId = institution.id;

      const tokenFor = async (email: string, role: UserRole): Promise<string> => {
        const user = await runner.runForTenant(tenantId, (tx) =>
          tx
            .selectFrom('users')
            .select('id')
            .where((eb) => eb(eb.fn('lower', ['email']), '=', email))
            .executeTakeFirstOrThrow(),
        );
        return tokens.issueAccessToken({ kind: 'USER', id: user.id, tenantId, role }).accessToken;
      };
      const adminToken = await tokenFor(staffEmail('admin'), 'INSTITUTION_ADMIN');

      // 3. Staff users, one per role (POST /v1/users); the admin exists from registration.
      for (const s of STAFF) {
        const created =
          s.role === 'INSTITUTION_ADMIN'
            ? registered !== undefined
            : (await http.create(
                '/v1/users',
                {
                  email: staffEmail(s.local),
                  fullName: s.name,
                  role: s.role,
                  password: staffPassword,
                },
                adminToken,
              )) !== undefined;
        summary.credentials.push({
          lender: lender.slug,
          role: s.role,
          email: staffEmail(s.local),
          password: created ? staffPassword : undefined,
        });
      }

      // 4. Branding: colours/locale (kept in sync with the catalogue) and the logo, if any.
      await syncBranding(lender, adminToken);

      // 5. Loan products (the product code is unique per tenant: 409 on re-runs, then the
      //    current terms are brought in line by publishing a new version when they differ).
      const products = demoProducts(lender);
      for (const product of products) {
        await http.create('/v1/loan-products', product, adminToken);
      }
      const checkout = await syncProducts(products, adminToken);

      // 5b. Applicants with a known outcome for the checkout product (nothing is created).
      summary.demoApplicants.push(
        ...findDemoApplicants({
          lender,
          tenantId,
          hmacKey: config.BVN_HMAC_KEY,
          terms: checkout,
          today: new Date().toISOString().slice(0, 10),
        }),
      );

      // 6. Two demo customers through the public self-registration route.
      for (const body of demoCustomers(lender, customerPassword)) {
        const created = await http.create(
          `/v1/institutions/${lender.slug}/customers/register`,
          body,
        );
        summary.credentials.push({
          lender: lender.slug,
          role: 'CUSTOMER',
          email: String(body.email),
          password: created ? customerPassword : undefined,
        });
      }
    }

    /**
     * Publishes a new version of an existing demo product whose current terms differ in
     * rate or origination fee from the catalogue (e.g. the checkout fee moving from DEDUCTED
     * to CAPITALISED), and returns the checkout product's current terms.
     */
    async function syncProducts(
      wanted: Record<string, unknown>[],
      token: string,
    ): Promise<CheckoutTerms> {
      const list = async () =>
        (await http.get<{ items: ProductItem[] }>('/v1/loan-products?limit=100', token)).items;
      for (const product of wanted) {
        const terms = product.terms as {
          annualInterestRateBps: number;
          originationFee: { type: string; value: string; treatment: string };
        };
        const current = (await list()).find((p) => p.code === product.code);
        if (!current) throw new Error(`Loan product ${String(product.code)} is missing`);
        const fee = current.terms.originationFee;
        const same =
          current.terms.annualInterestRateBps === terms.annualInterestRateBps &&
          fee.type === terms.originationFee.type &&
          fee.value === terms.originationFee.value &&
          fee.treatment === terms.originationFee.treatment;
        if (same) continue;
        await http.create(
          `/v1/loan-products/${current.id}/versions`,
          { expectedVersion: current.currentVersion, terms: product.terms },
          token,
        );
      }
      const checkout = (await list()).find((p) => p.code === CHECKOUT_PRODUCT_CODE);
      if (!checkout) throw new Error(`Loan product ${CHECKOUT_PRODUCT_CODE} is missing`);
      const t = checkout.terms;
      return {
        productCode: checkout.code,
        currency: t.currency,
        annualInterestRateBps: t.annualInterestRateBps,
        minPrincipal: BigInt(t.minPrincipal),
        term: t.minTerm,
        originationFee: {
          type: t.originationFee.type,
          value: BigInt(t.originationFee.value),
          treatment: t.originationFee.treatment === 'CAPITALISED' ? 'CAPITALISED' : 'DEDUCTED',
        },
        maxDtiBps: t.maxDtiBps ?? 4000,
        minCreditScore: t.minCreditScore ?? 0,
      };
    }

    async function syncBranding(lender: DemoLender, token: string): Promise<void> {
      const current = await http.get<Branding>('/v1/institution/branding', token);
      const logoObjectKey = current.logoObjectKey ?? (await uploadLogo(lender, token));
      const unchanged =
        current.displayName === lender.displayName &&
        current.primaryColor.toLowerCase() === lender.primaryColor.toLowerCase() &&
        current.secondaryColor.toLowerCase() === lender.secondaryColor.toLowerCase() &&
        current.locale === lender.locale &&
        current.logoObjectKey === logoObjectKey;
      if (unchanged) return;
      await http.put(
        '/v1/institution/branding',
        {
          displayName: lender.displayName,
          primaryColor: lender.primaryColor,
          secondaryColor: lender.secondaryColor,
          supportEmail: current.supportEmail ?? `support@${lender.slug}.example`,
          supportPhone: current.supportPhone,
          websiteUrl: current.websiteUrl,
          locale: lender.locale,
          logoObjectKey,
          expectedVersion: current.version,
        },
        token,
      );
    }

    /** Presigned S3 POST (the same flow a front-end uses); null when there is no logo file. */
    async function uploadLogo(lender: DemoLender, token: string): Promise<string | null> {
      if (!lender.logoPath) return null;
      const contentType = LOGO_TYPES[path.extname(lender.logoPath).toLowerCase()];
      const bytes = await readFile(lender.logoPath).catch(() => undefined);
      if (!contentType || !bytes) {
        out(`  (no usable logo for ${lender.slug} at ${lender.logoPath}; skipped)`);
        return null;
      }
      const form = await http.create<{
        url: string;
        fields: Record<string, string>;
        objectKey: string;
      }>('/v1/institution/branding/logo-upload-url', { contentType }, token);
      if (!form) throw new Error('logo upload form was not issued');
      const body = new FormData();
      for (const [k, v] of Object.entries(form.fields)) body.append(k, v);
      body.append('file', new Blob([bytes], { type: contentType }), path.basename(lender.logoPath));
      const res = await fetch(form.url, { method: 'POST', body });
      if (!res.ok) throw new Error(`logo upload for ${lender.slug} failed with ${res.status}`);
      return form.objectKey;
    }
  } finally {
    await app.close();
  }
}

/** Plain-text table. Passwords appear only for accounts created now, and only locally. */
export function credentialsTable(rows: CredentialRow[], local: boolean): string {
  const header = ['LENDER', 'ROLE', 'EMAIL', 'PASSWORD'];
  const body = rows.map((r) => [
    r.lender,
    r.role,
    r.email,
    r.password === undefined ? '(unchanged)' : local ? r.password : '(set from env)',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    local ? 'Credentials (LOCAL ONLY - never reuse these anywhere else):' : 'Accounts:',
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...body.map(line),
  ].join('\n');
}

/* istanbul ignore next -- CLI entrypoint */
if (require.main === module) {
  seed({ env: process.env, out: (line) => process.stdout.write(`${line}\n`) }).catch(
    (err: unknown) => {
      process.stderr.write(`[seed] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
