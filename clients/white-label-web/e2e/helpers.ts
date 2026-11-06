import { readFileSync } from 'node:fs';

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

/**
 * Registers a pharmacy through the UI using a seeded demo applicant with the wanted outcome
 * (demo-brands/demo-applicants.json). A used applicant answers 409 and the page fills in the
 * next one (or a random applicant when none is left), so submitting again moves on.
 * Leaves the page on the checkout.
 */
export async function signUpPharmacy(
  page: Page,
  slug: string,
  outcome: 'APPROVE' | 'COUNTER_OFFER' | 'DECLINE' = 'APPROVE',
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
  await page.getByRole('button', { name: /Sign in|Se connecter/ }).click();
  await expect(page).toHaveURL(/\/admin\/applications/);
  return page;
}

/**
 * In-app navigation. Sessions live in memory only (never localStorage), so a full page load
 * (`page.goto`) signs the user out; this goes through the router instead.
 */
export async function spaNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
