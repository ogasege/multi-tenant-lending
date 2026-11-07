/**
 * Captures the demo screenshots under screenshots/ (run: `npm run screenshots`). Each lender
 * in demo-brands/lenders.json that the local stack knows gets the same screens, themed only
 * by its branding API. Each lender uses one seeded APPROVE demo applicant (signed in again on
 * repeat runs, see startPharmacySession), so screenshots never eat into the sign-up cap.
 */
import { expect, test, type Page } from '@playwright/test';

import manifest from '../demo-brands/lenders.json' with { type: 'json' };

import {
  apiIsUp,
  lenderExists,
  STAFF_PASSWORD,
  startPharmacySession,
  spaNavigate,
  staffPage,
} from './helpers';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });

for (const lender of manifest.lenders) {
  test(`screens for ${lender.slug}`, async ({ browser }) => {
    test.setTimeout(240_000);
    test.skip(!(await apiIsUp()), 'API not reachable — run `make up`');
    test.skip(!(await lenderExists(lender.slug)), `${lender.slug} not seeded in a reachable cell`);

    const phone = await (
      await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
    ).newPage();
    await phone.goto(`/l/${lender.slug}`);
    await expect(phone.locator('.hero')).toBeVisible();
    await shot(phone, `${lender.slug}-1-home`);

    // A seeded APPROVE demo applicant, signed in again on repeat runs (no sign-up).
    await startPharmacySession(phone, lender.slug, 'APPROVE');
    await expect(phone.getByTestId('disclosure')).toBeVisible();
    await shot(phone, `${lender.slug}-2-finance-cart`);

    await phone.getByRole('button', { name: /Apply|Demander/ }).click();
    await expect(phone.getByTestId('application-headline')).toBeVisible();
    const applicationId = phone.url().split('/').pop()!;
    await shot(phone, `${lender.slug}-3-status`);

    if (!STAFF_PASSWORD) return;
    const credit = await staffPage(browser, lender.slug, 'credit');
    await spaNavigate(credit, `/l/${lender.slug}/admin/applications`);
    await expect(credit.getByTestId('applications')).toBeVisible();
    await shot(credit, `${lender.slug}-4-queue`);
    await spaNavigate(credit, `/l/${lender.slug}/admin/applications/${applicationId}`);
    await credit.getByRole('button', { name: /Run credit assessment|Lancer/ }).click();
    await expect(credit.getByRole('button', { name: /Re-run assessment|Relancer/ })).toBeEnabled();
    await expect(credit.getByTestId('decision')).toHaveText(/APPROVE|COUNTER_OFFER|REFER/);
    await shot(credit, `${lender.slug}-5-decision`);
    await credit.getByRole('button', { name: /^(Approve|Approuver)/ }).click();
    await credit.getByRole('link', { name: /Open loan|Ouvrir le prêt/ }).click();
    const loanUrl = new URL(credit.url()).pathname;

    const finance = await staffPage(browser, lender.slug, 'finance');
    await spaNavigate(finance, loanUrl);
    await finance.getByRole('button', { name: /Disburse|Décaisser/ }).click();
    await expect(finance.getByTestId('disbursed')).toBeVisible();
    // Resend the disbursement with the same Idempotency-Key: replayed, no double payout.
    await finance.getByRole('button', { name: /Developer view/ }).click();
    await finance.getByRole('button', { name: 'Resend with the same key' }).first().click();
    await expect(finance.locator('.dev-row-replayed').first()).toBeAttached();
    await finance.locator('.dev-list').evaluate((el) => {
      el.scrollTop = 0;
    });
    await shot(finance, `${lender.slug}-6-disbursed-devview`);
    await finance.getByRole('button', { name: 'Close developer view' }).click();

    await spaNavigate(finance, `/l/${lender.slug}/admin/ledger`);
    await expect(finance.getByTestId('balanced')).toBeVisible();
    await shot(finance, `${lender.slug}-7-trial-balance`);
    await spaNavigate(finance, `/l/${lender.slug}/admin/audit`);
    await finance.getByRole('button', { name: /Verify chain|Vérifier/ }).click();
    await expect(finance.getByTestId('audit-verified')).toBeVisible();
    await shot(finance, `${lender.slug}-8-audit-verified`);

    await spaNavigate(phone, `/l/${lender.slug}/applications/${applicationId}`);
    await phone.getByRole('link', { name: /schedule|échéancier/i }).click();
    await expect(phone.getByTestId('schedule')).toBeVisible();
    await shot(phone, `${lender.slug}-9-schedule`);
  });
}
