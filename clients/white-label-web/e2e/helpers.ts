import { randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { expect, type Browser, type Page } from '@playwright/test';

/** A value from the repo's local `.env` (LOCAL ONLY values), if present. */
function fromRepoEnv(name: string): string | undefined {
  try {
    const text = readFileSync(new URL('../../../.env', import.meta.url), 'utf8');
    return new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

export const API_URL = process.env.API_URL ?? 'http://localhost:3000';
export const SLUG = process.env.LENDER_SLUG ?? 'eko-medicredit';
/** Seed staff password (env, else the repo's `.env` that `make seed` used). */
export const STAFF_PASSWORD =
  process.env.SEED_STAFF_PASSWORD ??
  process.env.STAFF_PASSWORD ??
  fromRepoEnv('SEED_STAFF_PASSWORD');

/** The pharmacy status page's poll interval (STATUS_POLL_MS in ApplicationStatus.tsx). */
export const STATUS_POLL_MS = 4000;

export async function apiIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health/ready`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function lenderExists(slug: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/v1/institutions/${slug}/branding`);
    return res.ok;
  } catch {
    return false;
  }
}

type Outcome = 'APPROVE' | 'COUNTER_OFFER' | 'DECLINE';

interface SeededApplicant {
  expectedDecision: Outcome;
  request: { productCode: string };
  registration: { nationalId: string; email: string };
}

interface SeededFile {
  generatedAt: string;
  lenders: Record<string, { applicants: SeededApplicant[] } | undefined>;
}

interface DemoAccount {
  nationalId: string;
  email: string;
  password: string;
}

interface AccountsFile {
  /** `generatedAt` of the demo-applicants file these accounts belong to. */
  seededAt: string;
  /** slug → demo accounts this machine registered. */
  accounts: Record<string, DemoAccount[] | undefined>;
}

const SEEDED_PATH = new URL('../demo-brands/demo-applicants.json', import.meta.url);
const STATE_DIR = new URL('./.state/', import.meta.url);
const ACCOUNTS_PATH = new URL('./.state/demo-accounts.json', import.meta.url);
const RESEED = 'make clean && make up PROFILES=two-cells && make seed-all';

function seededFile(): SeededFile | null {
  return existsSync(SEEDED_PATH)
    ? (JSON.parse(readFileSync(SEEDED_PATH, 'utf8')) as SeededFile)
    : null;
}

/** Accounts registered by earlier runs against the same seed (a re-seed starts afresh). */
function loadAccounts(seededAt: string): AccountsFile {
  if (existsSync(ACCOUNTS_PATH)) {
    const file = JSON.parse(readFileSync(ACCOUNTS_PATH, 'utf8')) as AccountsFile;
    if (file.seededAt === seededAt) return file;
  }
  return { seededAt, accounts: {} };
}

function saveAccounts(file: AccountsFile): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(ACCOUNTS_PATH, `${JSON.stringify(file, null, 2)}\n`);
}

/** A policy-compliant password (12+, upper, lower, digit), kept only in e2e/.state. */
function accountPassword(): string {
  return `E2e-${String(randomInt(1e9)).padStart(9, '0')}-Pass`;
}

/**
 * Starts a pharmacy session for a seeded demo applicant with the wanted outcome and leaves the
 * page on the checkout, with that applicant's product preselected.
 *
 * The public sign-up is capped per lender (30 an hour) and every attempt counts, a 409 for an
 * already-registered national id included. So an applicant this machine registered before is
 * signed in again (no sign-up); only otherwise is a new one registered, and its credentials are
 * kept in e2e/.state/demo-accounts.json (git-ignored, reset by a re-seed). Re-applying is safe:
 * the scorecard uses the profile and active arrears, not earlier loans, so the outcome holds.
 * When every seeded applicant is taken it fails with the re-seed command instead of trying
 * random applicants (unknown outcomes, more sign-ups). Without a seed file it falls back to the
 * page's random applicant.
 */
export async function startPharmacySession(
  page: Page,
  slug: string,
  outcome: Outcome = 'APPROVE',
): Promise<void> {
  const seeded = seededFile();
  const applicants = (seeded?.lenders[slug]?.applicants ?? []).filter(
    (a) => a.expectedDecision === outcome,
  );
  if (!seeded || applicants.length === 0) {
    await signUpPharmacy(page, slug, outcome);
    return;
  }
  const state = loadAccounts(seeded.generatedAt);
  const known = (): DemoAccount[] => state.accounts[slug] ?? [];

  for (const applicant of applicants) {
    const id = applicant.registration.nationalId;
    const account = known().find((a) => a.nationalId === id);
    if (!account) continue;
    if (await signInPharmacy(page, slug, account.email, account.password)) {
      await openCheckout(page, slug, applicant.request.productCode);
      return;
    }
    state.accounts[slug] = known().filter((a) => a.nationalId !== id); // e.g. a reset database
    saveAccounts(state);
  }

  // Register the next seeded applicant the page offers, remembering the credentials used.
  await page.goto(`/l/${slug}/signup`);
  const picker = page.getByLabel(/Demo applicant outcome|Issue du demandeur/);
  if ((await picker.count()) > 0) await picker.selectOption(outcome);
  await page.getByRole('button', { name: /Fill demo details|Remplir/ }).click();
  const checkout = new RegExp(`/l/${slug}/checkout`);
  let tries = applicants.length;
  while (tries-- > 0) {
    if (!(await page.getByTestId('demo-scenario').isVisible())) break; // page fell back to random
    const nationalId = await page.getByLabel(/BVN or NIN|N° d’identification/).inputValue();
    const email = await page.getByLabel(/^(Email|E-mail)$/).inputValue();
    const password = accountPassword();
    await page.getByLabel(/^(Password|Mot de passe)/).fill(password);
    await page.getByRole('button', { name: /Create account|Créer le compte/ }).click();
    const shown = await Promise.race([
      page.waitForURL(checkout, { timeout: 15_000 }).then(() => 'checkout' as const),
      page
        .getByRole('alert')
        .waitFor({ timeout: 15_000 })
        .then(() => 'error' as const),
    ]);
    if (shown === 'checkout') {
      state.accounts[slug] = [...known(), { nationalId, email, password }];
      saveAccounts(state);
      return;
    }
    const message = (await page.getByRole('alert').first().textContent()) ?? '';
    if (message.includes('RATE_LIMITED')) {
      throw new Error(`Sign-up cap reached for ${slug}: ${message}. Reset with \`${RESEED}\`.`);
    }
  }
  throw new Error(
    `Every seeded ${outcome} demo applicant of ${slug} is already registered and none was ` +
      `registered by this machine (e2e/.state/demo-accounts.json). Re-seed: \`${RESEED}\`.`,
  );
}

/** Customer sign-in through the UI; false when the credentials are refused. */
async function signInPharmacy(
  page: Page,
  slug: string,
  email: string,
  password: string,
): Promise<boolean> {
  await page.goto(`/l/${slug}/login`);
  await page.getByLabel(/^(Email|E-mail)$/).fill(email);
  await page.getByLabel(/^(Password|Mot de passe)$/).fill(password);
  await submitLogin(page, () =>
    page.getByRole('button', { name: /^(Sign in|Se connecter)$/ }).click(),
  );
  const shown = await Promise.race([
    page.waitForURL(new RegExp(`/l/${slug}/checkout`), { timeout: 15_000 }).then(() => true),
    page
      .getByRole('alert')
      .waitFor({ timeout: 15_000 })
      .then(() => false),
  ]);
  return shown;
}

/** Re-opens the checkout with `productCode` preselected, as the sign-up page does. */
async function openCheckout(page: Page, slug: string, productCode: string): Promise<void> {
  await spaNavigate(page, `/l/${slug}`);
  await spaNavigate(page, `/l/${slug}/checkout`, { productCode });
  await expect(page).toHaveURL(new RegExp(`/l/${slug}/checkout`));
}

/**
 * Registers a pharmacy through the UI using a seeded demo applicant with the wanted outcome
 * (demo-brands/demo-applicants.json). A used applicant answers 409 and the page fills in the
 * next one (or a random applicant when none is left), so submitting again moves on. Every
 * attempt counts against the sign-up cap: prefer {@link startPharmacySession}.
 * Leaves the page on the checkout.
 */
export async function signUpPharmacy(
  page: Page,
  slug: string,
  outcome: Outcome = 'APPROVE',
): Promise<void> {
  await page.goto(`/l/${slug}/signup`);
  const picker = page.getByLabel(/Demo applicant outcome|Issue du demandeur/);
  if ((await picker.count()) > 0) await picker.selectOption(outcome);
  await page.getByRole('button', { name: /Fill demo details|Remplir/ }).click();
  const checkout = new RegExp(`/l/${slug}/checkout`);
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.getByRole('button', { name: /Create account|Créer le compte/ }).click();
    const outcomeShown = await Promise.race([
      page.waitForURL(checkout, { timeout: 15_000 }).then(() => 'checkout'),
      page
        .getByRole('alert')
        .waitFor({ timeout: 15_000 })
        .then(() => 'error'),
    ]);
    if (outcomeShown === 'checkout') return;
  }
  await expect(page).toHaveURL(checkout);
}

export async function staffPage(browser: Browser, slug: string, local: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.goto(`/l/${slug}/admin/login`);
  await page.getByLabel(/Email|E-mail/).fill(`${local}@${slug}.example`);
  await page.getByLabel(/Password|Mot de passe/).fill(STAFF_PASSWORD ?? '');
  await submitLogin(page, () => page.getByRole('button', { name: /Sign in|Se connecter/ }).click());
  await expect(page).toHaveURL(/\/admin\/applications/);
  return page;
}

/**
 * Submits a sign-in form. Sign-ins share a per-client budget (20 a minute), which back-to-back
 * spec runs can use up: on 429 it waits the server's `Retry-After` (at most a minute) and
 * submits once more, as the seed CLI does.
 */
async function submitLogin(page: Page, submit: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = page.waitForResponse(
      (r) => r.url().endsWith('/v1/auth/login') && r.request().method() === 'POST',
    );
    await submit();
    const res = await response;
    if (res.status() !== 429) return;
    const seconds = Number(res.headers()['retry-after'] ?? '60');
    await page.waitForTimeout(Math.min(Number.isFinite(seconds) ? seconds : 60, 60) * 1000 + 500);
  }
}

/**
 * In-app navigation. Sessions live in memory only (never localStorage), so a full page load
 * (`page.goto`) signs the user out; this goes through the router instead. `state` becomes the
 * router's `location.state`.
 */
export async function spaNavigate(page: Page, path: string, state?: unknown): Promise<void> {
  await page.evaluate(
    ({ to, usr }) => {
      const idx = ((window.history.state as { idx?: number } | null)?.idx ?? 0) + 1;
      const key = Math.random().toString(36).slice(2, 10);
      window.history.pushState({ usr, key, idx }, '', to);
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    { to: path, usr: state ?? null },
  );
}

/**
 * Failed API calls a page made (status 4xx/5xx), for failure messages: a page that keeps
 * showing old data usually has a failing refresh behind it.
 */
export function recordApiFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.pathname.includes('/v1/') && res.status() >= 400) {
      failures.push(`${res.request().method()} ${url.pathname} → ${res.status()}`);
    }
  });
  return failures;
}
