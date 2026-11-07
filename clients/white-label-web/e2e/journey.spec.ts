/**
 * Smoke test of the pharmacy journey against the local stack:
 *   sign-up → finance the supplier cart (APR + total cost of credit) → application status
 *   → [staff] assess + approve (credit officer) → disburse to supplier (finance officer)
 *   → [pharmacy] supplier paid, schedule + payoff.
 *
 * Needs `make up` + `make seed-all` from the repo root. Uses one seeded APPROVE demo
 * applicant; repeat runs sign that applicant in again instead of registering another (see
 * startPharmacySession). Staff steps need the seeded staff password in SEED_STAFF_PASSWORD;
 * without it the test stops after the application is submitted (the borrower half still runs).
 */
import { expect, test } from '@playwright/test';

import {
  API_URL,
  apiIsUp,
  lenderExists,
  recordApiFailures,
  SLUG,
  STAFF_PASSWORD,
  startPharmacySession,
  spaNavigate,
  staffPage,
  STATUS_POLL_MS,
} from './helpers';

test('pharmacy finances a supplier cart end to end', async ({ page, browser }) => {
  test.skip(!(await apiIsUp()), 'API not reachable on :3000 — run `make up` in the repo root');
  test.skip(!(await lenderExists(SLUG)), `lender ${SLUG} not seeded — run \`make seed-all\``);
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

  // 2. A seeded APPROVE demo applicant: signed in again if an earlier run registered it,
  //    else registered (the sign-up cap is 30 an hour per lender; see startPharmacySession).
  const apiFailures = recordApiFailures(page);
  await startPharmacySession(page, SLUG, 'APPROVE');

  // 3. Checkout: offers priced by POST /v1/loan-products/{id}/quote.
  await expect(page.getByTestId('cart-total')).toContainText('₦');
  await expect(page.getByTestId('disclosure')).toBeVisible();
  await expect(page.getByTestId('apr')).toContainText('%');
  await expect(page.getByTestId('tcc')).toContainText('₦');

  // 4. Apply (Idempotency-Key) → status page.
  await page.getByRole('button', { name: /Apply/ }).click();
  await expect(page).toHaveURL(/\/applications\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('application-headline')).toHaveText(/reviewing/);
  const applicationUrl = page.url();
  const applicationId = applicationUrl.split('/').pop()!;

  // Developer view shows the raw POST with its Idempotency-Key.
  await page.getByRole('button', { name: /Developer view/ }).click();
  await expect(
    page.getByTestId('dev-exchange').filter({ hasText: 'POST/v1/loan-applications' }).first(),
  ).toContainText('Idempotency-Key');
  await page.getByRole('button', { name: 'Close developer view' }).click();

  test.skip(!STAFF_PASSWORD, 'Set SEED_STAFF_PASSWORD to run the back-office half');

  // 5. Credit officer: assess (decision + reason codes), then approve (maker). The seed scored
  //    this applicant for this cart, so a decline means the seed and database disagree.
  const credit = await staffPage(browser, SLUG, 'credit');
  await spaNavigate(credit, `/l/${SLUG}/admin/applications/${applicationId}`);
  await credit.getByRole('button', { name: /Run credit assessment/ }).click();
  // Finished once the button offers a re-run (the decision shown is this assessment's).
  await expect(credit.getByRole('button', { name: /Re-run assessment/ })).toBeEnabled();
  await expect(credit.getByTestId('decision'), 'seeded APPROVE applicant').toHaveText(
    /APPROVE|COUNTER_OFFER|REFER/,
  );
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

  // 7. Pharmacy sees the supplier paid, then the schedule and payoff. The status page polls
  //    (and refreshes on focus); wait for the condition itself, bounded by a few poll cycles.
  await spaNavigate(page, new URL(applicationUrl).pathname);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByTestId('application-headline'),
    `pharmacy status after the loan closed; failed API calls: ${apiFailures.join(', ') || 'none'}`,
  ).toHaveText(/supplier has been paid/, { timeout: STATUS_POLL_MS * 4 });
  await expect(page.getByTestId('refresh-failed')).toHaveCount(0);
  await page.getByRole('link', { name: /View repayment schedule/ }).click();
  await expect(page.getByTestId('schedule')).toBeVisible();
  await expect(page.getByText('This loan is fully repaid.')).toBeVisible();
});
