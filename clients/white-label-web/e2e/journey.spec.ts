/**
 * Smoke test of the pharmacy journey against the local stack:
 *   sign-up → finance the supplier cart (APR + total cost of credit) → application status
 *   → [staff] assess + approve (credit officer) → disburse to supplier (finance officer)
 *   → [pharmacy] supplier paid, schedule + payoff.
 *
 * Needs `make up` + `make seed` from the repo root. Staff steps need the seeded staff
 * password in SEED_STAFF_PASSWORD; without it the test stops after the application is
 * submitted (the borrower half still runs).
 */
import { expect, test, type Page } from '@playwright/test';

import {
  API_URL,
  apiIsUp,
  lenderExists,
  SLUG,
  signUpPharmacy,
  STAFF_PASSWORD,
  spaNavigate,
  staffPage,
} from './helpers';

test('pharmacy finances a supplier cart end to end', async ({ page, browser }) => {
  test.skip(!(await apiIsUp()), 'API not reachable on :3000 — run `make up` in the repo root');
  test.skip(!(await lenderExists(SLUG)), `lender ${SLUG} not seeded — run \`make seed\``);
  test.setTimeout(240_000);

  // 1. Branding drives the theme: the CSS variable equals the API's primaryColor.
  const branding = (await (await fetch(`${API_URL}/v1/institutions/${SLUG}/branding`)).json()) as {
    primaryColor: string;
  };
  await page.goto(`/l/${SLUG}`);
  await expect(page.locator('.hero')).toBeVisible();
  const primary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim(),
  );
  expect(primary.toUpperCase()).toBe(branding.primaryColor.toUpperCase());

  // The mock bureau scores each BVN deterministically, so a random demo applicant can be
  // declined; a declined applicant is replaced by a fresh one (up to 12 tries).
  let applicationUrl = '';
  let credit: Page | null = null;
  for (let attempt = 1; ; attempt++) {
    // 2. Sign-up (public self-registration).
    await page.goto(`/l/${SLUG}`);
    await signUpPharmacy(page, SLUG);

    // 3. Checkout: offers priced by POST /v1/loan-products/{id}/quote.
    await expect(page.getByTestId('cart-total')).toContainText('₦');
    await expect(page.getByTestId('disclosure')).toBeVisible();
    await expect(page.getByTestId('apr')).toContainText('%');
    await expect(page.getByTestId('tcc')).toContainText('₦');

    // 4. Apply (Idempotency-Key) → status page.
    await page.getByRole('button', { name: /Apply/ }).click();
    await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('application-headline')).toHaveText(/reviewing/);
    applicationUrl = page.url();
    const applicationId = applicationUrl.split('/').pop()!;

    // Developer view shows the raw POST with its Idempotency-Key.
    await page.getByRole('button', { name: /Developer view/ }).click();
    await expect(
      page.getByTestId('dev-exchange').filter({ hasText: 'POST/v1/loan-applications' }).first(),
    ).toContainText('Idempotency-Key');
    await page.getByRole('button', { name: 'Close developer view' }).click();

    test.skip(!STAFF_PASSWORD, 'Set SEED_STAFF_PASSWORD to run the back-office half');

    // 5. Credit officer: assess (decision + reason codes), then approve (maker).
    credit ??= await staffPage(browser, SLUG, 'credit');
    await spaNavigate(credit, `/l/${SLUG}/admin/applications/${applicationId}`);
    await credit.getByRole('button', { name: /Run credit assessment/ }).click();
    const decision = credit.getByTestId('decision');
    await expect(decision).toHaveText(/APPROVE|COUNTER_OFFER|REFER|DECLINE/);
    if (!(await decision.textContent())?.includes('DECLINE')) break;
    expect(attempt, 'every demo applicant was declined').toBeLessThan(12);
  }
  await credit.getByRole('button', { name: /^Approve/ }).click();
  await expect(credit.getByRole('link', { name: 'Open loan' })).toBeVisible();
  await credit.getByRole('link', { name: 'Open loan' }).click();
  const loanUrl = new URL(credit.url()).pathname;

  // 5b. The approver cannot disburse (maker-checker, 403 SOD_VIOLATION).
  await credit.getByRole('button', { name: /Disburse/ }).click();
  await expect(credit.getByRole('alert')).toContainText(/FORBIDDEN|SOD_VIOLATION/);

  // 6. Finance officer (checker): disburse to the supplier.
  const finance = await staffPage(browser, SLUG, 'finance');
  await spaNavigate(finance, loanUrl);
  await finance.getByRole('button', { name: /Disburse/ }).click();
  await expect(finance.getByTestId('disbursed')).toBeVisible();

  // 6b. Record the payoff: a transfer needs its statement reference (not CASH).
  await finance.getByRole('button', { name: 'Use payoff amount' }).click();
  await finance.getByRole('button', { name: 'Record repayment' }).click();
  // The form refuses to submit without the reference (required for every channel but CASH).
  await expect(finance.locator('input:invalid')).toHaveCount(1);
  await finance.getByLabel('Bank reference').fill(`NIP-${Date.now()}`);
  await finance.getByRole('button', { name: 'Record repayment' }).click();
  await expect(finance.locator('.badge').filter({ hasText: 'CLOSED' })).toBeVisible();

  // 7. Pharmacy sees the supplier paid, then the schedule and payoff.
  await spaNavigate(page, new URL(applicationUrl).pathname);
  await expect(page.getByTestId('application-headline')).toHaveText(/supplier has been paid/);
  await page.getByRole('link', { name: /View repayment schedule/ }).click();
  await expect(page.getByTestId('schedule')).toBeVisible();
  await expect(page.getByText('This loan is fully repaid.')).toBeVisible();
});
