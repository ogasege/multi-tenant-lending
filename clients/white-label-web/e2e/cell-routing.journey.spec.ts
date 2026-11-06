/**
 * Cell routing against the local two-cell stack (`PROFILES=two-cells`): a Teranga (eu-west-3)
 * staff login started on the Lagos cell. The Lagos cell answers 307; the browser only sees an
 * opaque redirect (`redirect: 'manual'`), so the client re-asks the directory, checks the
 * answer against its allow-list and resends the login once to the EU cell.
 */
import { expect, test } from '@playwright/test';

import { STAFF_PASSWORD } from './helpers';

const SLUG = 'teranga-sante';
const EU_URL = process.env.API_EU_URL ?? 'http://localhost:3001';

test('a Teranga login started on the Lagos cell is resent once to its home cell', async ({
  page,
}) => {
  const euUp = await fetch(`${EU_URL}/v1/institutions/${SLUG}/branding`)
    .then((r) => r.ok)
    .catch(() => false);
  test.skip(!euUp, `${SLUG} not served on ${EU_URL}: run with PROFILES=two-cells and seed`);
  test.skip(!STAFF_PASSWORD, 'Set SEED_STAFF_PASSWORD to sign in as Teranga staff');

  // Keep the client on the Lagos cell: directory lookups at boot find nothing, and the
  // branding is served from the EU cell without moving the client.
  let directoryOpen = false;
  let lookupsAfterBoot = 0;
  await page.route(`**/cell/af-south-1/v1/directory/institutions/${SLUG}`, async (route) => {
    if (!directoryOpen) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({ status: 404, code: 'NOT_FOUND' }),
      });
    } else {
      lookupsAfterBoot += 1;
      await route.continue();
    }
  });
  await page.route(`**/cell/af-south-1/v1/institutions/${SLUG}/branding`, async (route) => {
    const response = await route.fetch({ url: `${EU_URL}/v1/institutions/${SLUG}/branding` });
    await route.fulfill({ response });
  });

  const logins: string[] = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/v1/auth/login')) logins.push(new URL(req.url()).pathname);
  });

  await page.goto(`/l/${SLUG}/admin/login`);
  await page.getByLabel(/Email|E-mail/).fill(`credit@${SLUG}.example`);
  await page.getByLabel(/Password|Mot de passe/).fill(STAFF_PASSWORD ?? '');
  directoryOpen = true;
  await page.getByRole('button', { name: /Sign in|Se connecter/ }).click();
  await expect(page).toHaveURL(/\/admin\/applications/);

  expect(logins).toEqual(['/cell/af-south-1/v1/auth/login', '/cell/eu-west-3/v1/auth/login']);
  expect(lookupsAfterBoot).toBe(1);

  await page.getByRole('button', { name: /Developer view/ }).click();
  const drawer = page.getByRole('complementary', { name: 'Developer view' });
  await expect(drawer).toContainText('cell eu-west-3 (redirect)');
  await expect(drawer).toContainText('resent once → /cell/eu-west-3/v1/auth/login');
  await expect(drawer.getByRole('alert')).toHaveCount(0);
});
