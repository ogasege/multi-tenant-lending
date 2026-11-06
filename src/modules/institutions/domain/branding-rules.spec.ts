import { randomUUID } from 'node:crypto';

import {
  isLogoContentType,
  isOwnLogoObjectKey,
  isValidSlug,
  LOCALE,
  logoObjectKey,
} from './branding-rules';

describe('branding rules', () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  it('builds logo keys under the tenant branding prefix with a matching extension', () => {
    const id = randomUUID();
    expect(logoObjectKey(tenantA, id, 'image/png')).toBe(
      `tenants/${tenantA}/branding/logo-${id}.png`,
    );
    expect(logoObjectKey(tenantA, id, 'image/jpeg')).toMatch(/\.jpg$/);
    expect(logoObjectKey(tenantA, id, 'image/webp')).toMatch(/\.webp$/);
  });

  it('accepts only keys the tenant itself could have been issued', () => {
    const own = logoObjectKey(tenantA, randomUUID(), 'image/png');
    expect(isOwnLogoObjectKey(tenantA, own)).toBe(true);
    expect(isOwnLogoObjectKey(tenantB, own)).toBe(false);
    expect(isOwnLogoObjectKey(tenantA, `tenants/${tenantA}/branding/../../${tenantB}/x.png`)).toBe(
      false,
    );
    expect(
      isOwnLogoObjectKey(tenantA, `tenants/${tenantA}/branding/logo-${randomUUID()}.svg`),
    ).toBe(false);
    expect(isOwnLogoObjectKey(tenantA, `tenants/${tenantA}/branding/`)).toBe(false);
  });

  it('excludes SVG from logo content types', () => {
    expect(isLogoContentType('image/png')).toBe(true);
    expect(isLogoContentType('image/svg+xml')).toBe(false);
    expect(isLogoContentType('toString')).toBe(false);
    expect(isLogoContentType(undefined)).toBe(false);
  });

  it.each(['en-NG', 'fr-SN', 'en-GB', 'fr-FR', 'en', 'zh-Hant-TW', 'es-419'])(
    'accepts locale %s',
    (locale) => {
      expect(LOCALE.test(locale)).toBe(true);
    },
  );

  it.each(['EN-ng', 'en_NG', 'english', 'en-NGA', '', 'fr-sn'])('rejects locale %s', (locale) => {
    expect(LOCALE.test(locale)).toBe(false);
  });

  it('validates slugs like the database CHECK', () => {
    expect(isValidSlug('acme-mfb')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('Acme')).toBe(false);
    expect(isValidSlug('acme--mfb')).toBe(false);
    expect(isValidSlug('-acme')).toBe(false);
  });
});
