import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseCellOrigins } from '../api/cellConfig';
import type { PublicBranding } from '../api/types';
import { DevView } from '../components/DevView';
import { LenderStore, useLender, LenderProvider } from './lender';
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

  it('ignores a poisoned directory entry: default cell, no request to that host, error shown', async () => {
    const fetchMock = fakeFetch(
      (url) =>
        url.endsWith('/v1/directory/institutions/teranga-sante')
          ? {
              body: {
                slug: 'teranga-sante',
                homeRegion: 'eu-west-3',
                apiBaseUrl: 'https://attacker.example.net',
                status: 'ACTIVE',
              },
            }
          : undefined,
      (url) => (url.endsWith('/branding') ? { body: TERANGA } : undefined),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LenderProvider
        slug="teranga-sante"
        cells={parseCellOrigins(undefined, { production: false, proxy: true })}
      >
        <Probe />
        <DevView />
      </LenderProvider>,
    );

    expect(await screen.findByText(/Teranga Santé Finance · .* · af-south-1/)).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : input.toString(),
    );
    expect(urls).toEqual([
      '/cell/af-south-1/v1/directory/institutions/teranga-sante',
      '/cell/af-south-1/v1/institutions/teranga-sante/branding',
    ]);
    expect(urls.some((u) => u.includes('attacker'))).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: /Developer view/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      /attacker\.example\.net, which is not an allow-listed cell/,
    );
  });
});

describe('LenderStore cell redirects (browser: opaque 307)', () => {
  const cells = parseCellOrigins(undefined, { production: false, proxy: true });
  const DIRECTORY = '/cell/af-south-1/v1/directory/institutions/teranga-sante';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const urlOf = (input: RequestInfo | URL): string =>
    input instanceof Request ? input.url : input.toString();

  /** Lagos cell: unknown directory at boot, then a given entry; 307 for Teranga's login. */
  function lagos(apiBaseUrl: string) {
    let directoryCalls = 0;
    return fakeFetch(
      (url) => {
        if (url !== DIRECTORY) return undefined;
        directoryCalls += 1;
        if (directoryCalls === 1) return { status: 404, body: { status: 404, code: 'NOT_FOUND' } };
        return { body: { slug: 'teranga-sante', homeRegion: 'eu-west-3', apiBaseUrl } };
      },
      (url) =>
        url === '/cell/af-south-1/v1/institutions/teranga-sante/branding'
          ? { body: TERANGA }
          : undefined,
      (url) => (url === '/cell/af-south-1/v1/auth/login' ? { opaqueRedirect: true } : undefined),
      (url) =>
        url === '/cell/eu-west-3/v1/auth/login'
          ? { body: { accessToken: 'a', refreshToken: 'r' } }
          : undefined,
    );
  }

  it('resends a login started on the Lagos cell to the allow-listed home cell, once', async () => {
    const fetchMock = lagos('http://localhost:3001');
    vi.stubGlobal('fetch', fetchMock);
    const store = new LenderStore(cells);
    await store.boot('teranga-sante');
    expect(store.base).toBe('/cell/af-south-1');

    await expect(
      store.api.customer.login('teranga-sante', 'awa@teranga.example', 'pw'),
    ).resolves.toMatchObject({ accessToken: 'a' });

    const logins = fetchMock.mock.calls.filter(([u]) => urlOf(u).endsWith('/v1/auth/login'));
    expect(logins.map(([u]) => urlOf(u))).toEqual([
      '/cell/af-south-1/v1/auth/login',
      '/cell/eu-west-3/v1/auth/login',
    ]);
    expect(logins[1]![1]!.body).toBe(logins[0]![1]!.body);
    expect(store.snapshot().cell).toMatchObject({ region: 'eu-west-3', source: 'redirect' });
  });

  it('refuses when the directory names a foreign host: nothing sent, error recorded', async () => {
    const fetchMock = lagos('https://attacker.example.net');
    vi.stubGlobal('fetch', fetchMock);
    const store = new LenderStore(cells);
    await store.boot('teranga-sante');

    await expect(
      store.api.customer.login('teranga-sante', 'awa@teranga.example', 'pw'),
    ).rejects.toMatchObject({ code: 'CELL_ROUTING_REFUSED' });

    const urls = fetchMock.mock.calls.map(([u]) => urlOf(u));
    expect(urls.some((u) => u.includes('attacker'))).toBe(false);
    expect(urls.filter((u) => u.endsWith('/v1/auth/login'))).toHaveLength(1);
    expect(store.snapshot().cell).toMatchObject({ region: 'af-south-1', source: 'default' });
    expect(store.snapshot().cell!.errors.join()).toMatch(/attacker\.example\.net/);
  });
});
