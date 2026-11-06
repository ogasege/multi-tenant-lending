import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicBranding } from '../api/types';
import { useLender, LenderProvider } from './lender';
import { fakeFetch } from '../test/fakeFetch';

const TERANGA: PublicBranding = {
  slug: 'teranga-sante',
  displayName: 'Teranga Santé Finance',
  primaryColor: '#A63D24',
  secondaryColor: '#1D4E89',
  locale: 'fr-SN',
  supportEmail: null,
  supportPhone: null,
  websiteUrl: null,
  logoUrl: null,
  defaultCurrency: 'XOF',
  supportedCurrencies: ['XOF'],
};

function Probe() {
  const { t, currency, cell, branding } = useLender();
  return (
    <p>
      {branding.displayName} · {t.financeThisCart} · {currency} · {cell.region}
    </p>
  );
}

describe('LenderProvider theming', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies CSS variables, lang, copy and currency purely from the branding API', async () => {
    const fetchMock = fakeFetch(
      (url) =>
        url === '/cell/af-south-1/v1/directory/institutions/teranga-sante'
          ? {
              body: {
                slug: 'teranga-sante',
                homeRegion: 'eu-west-3',
                apiBaseUrl: 'http://localhost:3001',
                status: 'ACTIVE',
              },
            }
          : undefined,
      (url) =>
        url === '/cell/eu-west-3/v1/institutions/teranga-sante/branding'
          ? { body: TERANGA }
          : undefined,
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LenderProvider slug="teranga-sante">
        <Probe />
      </LenderProvider>,
    );

    expect(
      await screen.findByText('Teranga Santé Finance · Financer ce panier · XOF · eu-west-3'),
    ).toBeInTheDocument();
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--brand-primary')).toBe('#A63D24');
    expect(style.getPropertyValue('--brand-on-primary')).toBe('#FFFFFF');
    expect(style.getPropertyValue('--brand-secondary')).toBe('#1D4E89');
    expect(document.documentElement.lang).toBe('fr-SN');
    expect(document.title).toBe('Teranga Santé Finance');
  });

  it('applies an AA fallback when the lender colour is too light for any text', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch((url) =>
        url.endsWith('/branding')
          ? { body: { ...TERANGA, slug: 'pale', primaryColor: '#7A7A7A', locale: 'en-NG' } }
          : undefined,
      ),
    );
    render(
      <LenderProvider slug="pale">
        <Probe />
      </LenderProvider>,
    );
    await screen.findByText(/Finance this cart/);
    expect(document.documentElement.style.getPropertyValue('--brand-primary')).not.toBe('#7A7A7A');
  });

  it('shows a not-found page for an unknown lender', async () => {
    vi.stubGlobal('fetch', fakeFetch());
    render(
      <LenderProvider slug="nobody">
        <Probe />
      </LenderProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Lender not found' })).toBeInTheDocument();
  });
});
