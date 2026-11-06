import { slugOfRequest } from './cell-routing.middleware';

describe('slugOfRequest', () => {
  it('takes the slug from /v1/institutions/{slug}/…', () => {
    expect(slugOfRequest({ originalUrl: '/v1/institutions/acme-mfb/branding', body: {} })).toBe(
      'acme-mfb',
    );
    expect(
      slugOfRequest({ originalUrl: '/v1/institutions/acme-mfb/customers/register?x=1', body: {} }),
    ).toBe('acme-mfb');
  });

  it('takes the slug from the login body', () => {
    expect(
      slugOfRequest({ originalUrl: '/v1/auth/login', body: { institutionSlug: 'acme-mfb' } }),
    ).toBe('acme-mfb');
  });

  it('prefers the path over the body', () => {
    expect(
      slugOfRequest({
        originalUrl: '/v1/institutions/path-slug/branding',
        body: { institutionSlug: 'body-slug' },
      }),
    ).toBe('path-slug');
  });

  it.each([
    ['/v1/institutions/Not%20A%20Slug/branding', {}],
    ['/v1/institutions/%E0%A4%A/branding', {}],
    ['/v1/auth/login', { institutionSlug: 42 }],
    ['/v1/auth/login', { institutionSlug: '@cell:af-south-1' }],
    ['/v1/auth/login', undefined],
  ])('ignores malformed slugs (%s)', (originalUrl, body) => {
    expect(slugOfRequest({ originalUrl, body })).toBeUndefined();
  });
});
