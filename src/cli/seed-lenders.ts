import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { LenderType } from '../common/database/schema';
import { assertCurrency, exponentOf } from '../common/money/currency';

/**
 * Demo lenders for `npm run seed`. All names and brands are FICTIONAL (original branding
 * only). The white-label front-end may provide its own catalogue with logos in
 * clients/white-label-web/demo-brands/lenders.json; otherwise the built-in list is used.
 */
export interface DemoLender {
  slug: string;
  legalName: string;
  displayName: string;
  city: string;
  countryCode: string;
  currency: string;
  lenderType: LenderType;
  maxAprBps: number | null;
  homeRegion: string;
  timezone: string;
  locale: string;
  primaryColor: string;
  secondaryColor: string;
  /** Absolute path of a PNG/JPEG/WebP logo, when one exists. */
  logoPath?: string;
}

export const BUILT_IN_LENDERS: readonly DemoLender[] = [
  {
    slug: 'eko-medicredit',
    legalName: 'Eko MediCredit Microfinance Bank Ltd',
    displayName: 'Eko MediCredit',
    city: 'Lagos',
    countryCode: 'NG',
    currency: 'NGN',
    lenderType: 'MICROFINANCE_BANK',
    maxAprBps: 4800,
    homeRegion: 'af-south-1',
    timezone: 'Africa/Lagos',
    locale: 'en-NG',
    primaryColor: '#0B6E4F',
    secondaryColor: '#10231C',
  },
  {
    slug: 'arewa-pharmafinance',
    legalName: 'Arewa PharmaFinance Ltd',
    displayName: 'Arewa PharmaFinance',
    city: 'Kano',
    countryCode: 'NG',
    currency: 'NGN',
    lenderType: 'FINANCE_COMPANY',
    maxAprBps: 4200,
    homeRegion: 'af-south-1',
    timezone: 'Africa/Lagos',
    locale: 'en-NG',
    primaryColor: '#B4531A',
    secondaryColor: '#2B1A10',
  },
  {
    slug: 'delta-carelend',
    legalName: 'Delta CareLend Ltd',
    displayName: 'Delta CareLend',
    city: 'Port Harcourt',
    countryCode: 'NG',
    currency: 'NGN',
    lenderType: 'MONEY_LENDER',
    maxAprBps: 3600,
    homeRegion: 'af-south-1',
    timezone: 'Africa/Lagos',
    locale: 'en-NG',
    primaryColor: '#1D4ED8',
    secondaryColor: '#0F172A',
  },
  {
    slug: 'teranga-sante',
    legalName: 'Teranga Santé Finance SA',
    displayName: 'Teranga Santé',
    city: 'Dakar',
    countryCode: 'SN',
    currency: 'XOF',
    lenderType: 'MICROFINANCE_INSTITUTION',
    maxAprBps: 2400,
    homeRegion: 'eu-west-3',
    timezone: 'Africa/Dakar',
    locale: 'fr-SN',
    primaryColor: '#7C3AED',
    secondaryColor: '#1E1B2E',
  },
];

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Accepts the obvious spellings a front-end catalogue may use; unknown keys are ignored. */
const catalogueEntry = z.object({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  legalName: z.string().min(2),
  displayName: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  city: z.string().optional(),
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  lenderType: z.enum([
    'COMMERCIAL_BANK',
    'MICROFINANCE_BANK',
    'FINANCE_COMPANY',
    'MONEY_LENDER',
    'MICROFINANCE_INSTITUTION',
  ]),
  maxAprBps: z.number().int().positive().nullable().optional(),
  homeRegion: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  primaryColor: z.string().regex(HEX).optional(),
  secondaryColor: z.string().regex(HEX).optional(),
  colors: z
    .object({ primary: z.string().regex(HEX), secondary: z.string().regex(HEX) })
    .partial()
    .optional(),
  colours: z
    .object({ primary: z.string().regex(HEX), secondary: z.string().regex(HEX) })
    .partial()
    .optional(),
  logo: z.string().optional(),
  logoFile: z.string().optional(),
});

const catalogue = z.union([
  z.array(catalogueEntry),
  z.object({ lenders: z.array(catalogueEntry) }),
]);

const COUNTRY_BY_CURRENCY: Record<string, string> = { NGN: 'NG', XOF: 'SN', GHS: 'GH', GBP: 'GB' };
const ZONE_BY_COUNTRY: Record<string, string> = {
  NG: 'Africa/Lagos',
  SN: 'Africa/Dakar',
  GH: 'Africa/Accra',
  GB: 'Europe/London',
};

/** Parses a catalogue file's content; `dir` resolves relative logo paths. */
export function parseLenderCatalogue(json: string, dir: string): DemoLender[] {
  const parsed = catalogue.parse(JSON.parse(json));
  const entries = Array.isArray(parsed) ? parsed : parsed.lenders;
  return entries.map((e) => {
    const builtIn = BUILT_IN_LENDERS.find((b) => b.slug === e.slug);
    const countryCode =
      e.countryCode ?? builtIn?.countryCode ?? COUNTRY_BY_CURRENCY[e.currency] ?? 'NG';
    const logo = e.logo ?? e.logoFile;
    return {
      slug: e.slug,
      legalName: e.legalName,
      displayName: e.displayName ?? e.name ?? builtIn?.displayName ?? e.legalName,
      city: e.city ?? builtIn?.city ?? '',
      countryCode,
      currency: e.currency,
      lenderType: e.lenderType,
      maxAprBps: e.maxAprBps ?? builtIn?.maxAprBps ?? null,
      homeRegion: e.homeRegion,
      timezone: e.timezone ?? builtIn?.timezone ?? ZONE_BY_COUNTRY[countryCode] ?? 'Africa/Lagos',
      locale: e.locale ?? builtIn?.locale ?? 'en-NG',
      primaryColor:
        e.primaryColor ??
        e.colours?.primary ??
        e.colors?.primary ??
        builtIn?.primaryColor ??
        '#0B5FFF',
      secondaryColor:
        e.secondaryColor ??
        e.colours?.secondary ??
        e.colors?.secondary ??
        builtIn?.secondaryColor ??
        '#111827',
      logoPath: logo ? path.resolve(dir, logo) : undefined,
    };
  });
}

export const DEFAULT_CATALOGUE = path.resolve(
  __dirname,
  '../../clients/white-label-web/demo-brands/lenders.json',
);

/** The front-end catalogue when it exists, else the built-in list. */
export function loadLenders(file = DEFAULT_CATALOGUE): { lenders: DemoLender[]; source: string } {
  let json: string;
  try {
    json = readFileSync(file, 'utf8');
  } catch {
    return { lenders: [...BUILT_IN_LENDERS], source: 'built-in list' };
  }
  return { lenders: parseLenderCatalogue(json, path.dirname(file)), source: file };
}

/** `units` whole currency units in minor units (NGN has 2 decimals, XOF none). */
function major(currency: string, units: number): string {
  return (BigInt(units) * 10n ** BigInt(exponentOf(assertCurrency(currency)))).toString();
}

/** Rounds down to whole percent points (bps multiple of 100). */
const pct = (bps: number) => Math.floor(bps / 100) * 100;

/** Code of the checkout-financing product (supplier paid the full cart at disbursement). */
export const CHECKOUT_PRODUCT_CODE = 'SUPPLIER_30';

/**
 * The two demo products of a lender, in its currency and priced under its APR cap: the
 * worst-case all-in APR (nominal rate plus annualised origination fee, at the minimum
 * principal and term) must not exceed `maxAprBps`; product creation enforces it.
 *
 * Fee treatment differs on purpose:
 * - `SUPPLIER_30` (checkout financing) CAPITALISES the fee: the supplier is paid the full
 *   cart amount and the fee is added to what the pharmacy repays. A deducted fee would pay
 *   the supplier less than the cart total.
 * - `WORKING_CAPITAL` (cash to the borrower) DEDUCTS the fee from the cash disbursed.
 */
export function demoProducts(lender: DemoLender): Record<string, unknown>[] {
  const cap = lender.maxAprBps ?? 4800;
  const lowCap = cap < 3600;
  const xof = lender.currency === 'XOF';
  // Ticket sizes in whole units: NGN 50k–5m / 100k–10m; XOF 100k–10m / 200k–20m.
  const [bulletMin, bulletMax, termMin, termMax] = xof
    ? [100_000, 10_000_000, 200_000, 20_000_000]
    : [50_000, 5_000_000, 100_000, 10_000_000];
  return [
    {
      code: CHECKOUT_PRODUCT_CODE,
      name: lender.locale.startsWith('fr')
        ? 'Réassort fournisseur — 30 jours'
        : 'Supplier restock — 30 days',
      description:
        'Checkout finance: the supplier is paid the full cart; the fee is added to the ' +
        'loan and repaid with it in one bullet after 30 days.',
      terms: {
        currency: lender.currency,
        minPrincipal: major(lender.currency, bulletMin),
        maxPrincipal: major(lender.currency, bulletMax),
        minTerm: 30,
        maxTerm: 30,
        repaymentFrequency: 'BULLET',
        interestMethod: 'FLAT',
        annualInterestRateBps: Math.min(3000, pct(cap * 0.55)),
        originationFee: {
          type: 'PERCENTAGE',
          value: lowCap ? '50' : '100',
          treatment: 'CAPITALISED',
        },
        lateFee: { type: 'PERCENTAGE', value: '100', graceDays: 3 },
        disbursementMode: 'VENDOR',
      },
    },
    {
      code: 'WORKING_CAPITAL',
      name: lender.locale.startsWith('fr')
        ? 'Fonds de roulement — mensuel'
        : 'Working capital — monthly',
      description: 'Reducing-balance term loan repaid monthly over 3 to 12 months.',
      terms: {
        currency: lender.currency,
        minPrincipal: major(lender.currency, termMin),
        maxPrincipal: major(lender.currency, termMax),
        minTerm: 3,
        maxTerm: 12,
        repaymentFrequency: 'MONTHLY',
        interestMethod: 'REDUCING_BALANCE',
        annualInterestRateBps: Math.min(3600, pct(cap * 0.7)),
        originationFee: { type: 'PERCENTAGE', value: lowCap ? '50' : '150', treatment: 'DEDUCTED' },
        lateFee: { type: 'PERCENTAGE', value: '100', graceDays: 5 },
        disbursementMode: 'BORROWER',
      },
    },
  ];
}

/** A deterministic 11-digit national id per (lender, n): re-runs hit the duplicate check. */
export function nationalIdFor(slug: string, n: number): string {
  const digits = BigInt(
    `0x${createHash('sha256').update(`${slug}:${n}`).digest('hex').slice(0, 12)}`,
  );
  return `2${(digits % 10_000_000_000n).toString().padStart(10, '0')}`;
}

/** Two demo customers (a pharmacy and a clinic) for the public self-registration route. */
export function demoCustomers(lender: DemoLender, password: string): Record<string, unknown>[] {
  const sn = lender.countryCode === 'SN';
  const income = (units: number) => major(lender.currency, sn ? units * 4 : units);
  const people = sn
    ? [
        {
          first: 'Awa',
          last: 'Diop',
          business: 'Pharmacie Teranga Plus',
          licence: 'ONP/2023/0142',
        },
        {
          first: 'Moussa',
          last: 'Ndiaye',
          business: 'Clinique Santé Liberté',
          licence: 'MSAS/CL/2022/087',
        },
      ]
    : [
        {
          first: 'Amaka',
          last: 'Eze',
          business: 'HealthPlus Pharmacy Ltd',
          licence: 'PCN/PREM/2024/0001',
        },
        {
          first: 'Tunde',
          last: 'Bello',
          business: 'Mercy Family Clinic Ltd',
          licence: 'HEFAMAA/2023/0456',
        },
      ];
  return people.map((p, i) => ({
    customerType: 'BUSINESS',
    businessName: p.business,
    businessRegistrationNumber: `${sn ? 'SN-DKR-' : 'RC'}${nationalIdFor(lender.slug, 10 + i).slice(-7)}`,
    operatingLicenceNumber: p.licence,
    firstName: p.first,
    lastName: p.last,
    email: `${p.first.toLowerCase()}.${p.last.toLowerCase()}@${lender.slug}.customers.example`,
    phone: sn ? `+22177123450${i}` : `+23480123456${70 + i}`,
    dateOfBirth: i === 0 ? '1985-04-12' : '1979-09-30',
    nationalId: nationalIdFor(lender.slug, i),
    employmentStatus: 'BUSINESS_OWNER',
    monthsInEmployment: 48 + i * 24,
    currency: lender.currency,
    monthlyIncome: income(1_500_000 + i * 500_000),
    monthlyExpenses: income(600_000 + i * 200_000),
    existingMonthlyDebt: '0',
    password,
  }));
}
