import type { DirectoryEntry } from './directory-entry';
import { decideRouting, type RoutingInput } from './routing-decision';

const remote: DirectoryEntry = {
  slug: 'acme-mfb',
  institutionId: '7b0c6c1e-0000-4000-8000-000000000001',
  homeRegion: 'af-south-1',
  apiBaseUrl: 'https://af-south-1.api.example.com',
  status: 'ACTIVE',
  version: 1,
  updatedAt: '2026-11-06T00:00:00.000Z',
};

const input = (overrides: Partial<RoutingInput> = {}): RoutingInput => ({
  slug: 'acme-mfb',
  isLocal: false,
  entry: remote,
  cellRegion: 'eu-west-3',
  originalUrl: '/v1/auth/login',
  allowInsecure: false,
  trustedOrigin: (region) =>
    ({
      'af-south-1': 'https://af-south-1.api.example.com',
      'eu-west-3': 'https://eu-west-3.api.example.com',
    })[region],
  ...overrides,
});

describe('decideRouting (cell routing decision table)', () => {
  it('redirects a tenant homed in another cell to its base URL + original URL', () => {
    expect(decideRouting(input({ originalUrl: '/v1/institutions/acme-mfb/branding?x=1' }))).toEqual(
      {
        action: 'redirect',
        location: 'https://af-south-1.api.example.com/v1/institutions/acme-mfb/branding?x=1',
        homeRegion: 'af-south-1',
        apiBaseUrl: 'https://af-south-1.api.example.com',
      },
    );
  });

  it('redirects suspended tenants too (their home cell owns the answer)', () => {
    expect(decideRouting(input({ entry: { ...remote, status: 'SUSPENDED' } })).action).toBe(
      'redirect',
    );
  });

  it.each<[string, Partial<RoutingInput>]>([
    ['no slug in the request', { slug: undefined }],
    ['the slug is stored in this cell', { isLocal: true }],
    ['the slug is unknown to the directory (no enumeration oracle)', { entry: undefined }],
    [
      'the directory says the tenant is homed here (no redirect loop)',
      { cellRegion: 'af-south-1' },
    ],
    ['the directory entry is for another slug', { entry: { ...remote, slug: 'other-mfb' } }],
    [
      'the base URL is plain http in production',
      { entry: { ...remote, apiBaseUrl: 'http://a.test' } },
    ],
    ['the base URL carries a path', { entry: { ...remote, apiBaseUrl: 'https://a.test/evil' } }],
    ['the original URL is not a path', { originalUrl: 'https://evil.test/' }],
    [
      'the base URL is not the configured origin of its region (poisoned directory)',
      { entry: { ...remote, apiBaseUrl: 'https://evil.example.com' } },
    ],
    [
      'the home region is not a configured cell',
      { entry: { ...remote, homeRegion: 'ap-south-9' } },
    ],
  ])('passes through when %s', (_case, overrides) => {
    expect(decideRouting(input(overrides))).toEqual({ action: 'pass' });
  });

  it('accepts http base URLs only when insecure origins are allowed', () => {
    const entry = { ...remote, apiBaseUrl: 'http://cell-a.test' };
    const trustedOrigin = () => 'http://cell-a.test';
    expect(decideRouting(input({ entry, allowInsecure: true, trustedOrigin }))).toMatchObject({
      action: 'redirect',
      location: 'http://cell-a.test/v1/auth/login',
    });
  });
});
