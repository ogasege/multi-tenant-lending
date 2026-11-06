import { isValidRegion, isValidSlug, parseApiBaseUrl } from './directory-entry';

describe('parseApiBaseUrl', () => {
  it.each([
    ['https://af-south-1.api.example.com', 'https://af-south-1.api.example.com'],
    ['https://af-south-1.api.example.com/', 'https://af-south-1.api.example.com'],
    ['https://api.example.com:8443', 'https://api.example.com:8443'],
    ['HTTPS://API.EXAMPLE.COM', 'https://api.example.com'],
  ])('accepts the bare https origin %s', (raw, origin) => {
    expect(parseApiBaseUrl(raw, false)).toBe(origin);
  });

  it.each([
    ['http://api.example.com', 'plain http in production'],
    ['javascript:alert(1)', 'a script URL'],
    ['ftp://api.example.com', 'a non-HTTP scheme'],
    ['https://user:pw@api.example.com', 'embedded credentials'],
    ['https://api.example.com/v1', 'a path'],
    ['https://api.example.com/?next=https://evil.test', 'a query'],
    ['https://api.example.com/#x', 'a fragment'],
    ['//evil.test', 'a protocol-relative URL'],
    ['not a url', 'garbage'],
    ['', 'an empty string'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseApiBaseUrl(raw, false)).toBeUndefined();
  });

  it('rejects non-strings and oversized values', () => {
    expect(parseApiBaseUrl(undefined, true)).toBeUndefined();
    expect(parseApiBaseUrl(42, true)).toBeUndefined();
    expect(parseApiBaseUrl(`https://${'a'.repeat(2050)}.test`, true)).toBeUndefined();
  });

  it('allows plain http only when insecure origins are allowed (test/development)', () => {
    expect(parseApiBaseUrl('http://cell-a.test', true)).toBe('http://cell-a.test');
    expect(parseApiBaseUrl('http://cell-a.test', false)).toBeUndefined();
  });

  it('has no loopback exception in production', () => {
    expect(parseApiBaseUrl('http://localhost:3000', false)).toBeUndefined();
    expect(parseApiBaseUrl('http://127.0.0.1', false)).toBeUndefined();
  });
});

describe('isValidSlug / isValidRegion', () => {
  it('follows the institutions.slug constraint', () => {
    expect(isValidSlug('acme-mfb')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('Acme')).toBe(false);
    expect(isValidSlug('acme--mfb')).toBe(false);
    expect(isValidSlug('@cell:af-south-1')).toBe(false);
    expect(isValidSlug('a'.repeat(64))).toBe(false);
    expect(isValidSlug(undefined)).toBe(false);
  });

  it('accepts AWS region codes only', () => {
    expect(isValidRegion('af-south-1')).toBe(true);
    expect(isValidRegion('us-gov-west-1')).toBe(true);
    expect(isValidRegion('Lagos')).toBe(false);
    expect(isValidRegion('af-south')).toBe(false);
  });
});
