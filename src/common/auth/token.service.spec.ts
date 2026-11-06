import { JwtService } from '@nestjs/jwt';

import type { Env } from '../../config/env.schema';
import { MisdirectedRequestError, UnauthenticatedError } from '../errors/app-error';

import { TokenService } from './token.service';

const SECRET = 'x'.repeat(64);

const CELL_ORIGINS: Readonly<Record<string, string>> = {
  'af-south-1': 'https://af-south-1.api.test',
  'eu-west-3': 'https://eu-west-3.api.test',
};

const serviceFor = (cell: string, secret = SECRET): TokenService =>
  new TokenService(new JwtService({ secret }), {
    JWT_ISSUER: 'test-issuer',
    JWT_ACCESS_TTL_SECONDS: 900,
    CELL_REGION: cell,
    CELL_API_BASE_URL: CELL_ORIGINS[cell] ?? `https://${cell}.api.test`,
    CELL_ORIGINS,
  } as Partial<Env> as Env);

const tenantUser = {
  kind: 'USER' as const,
  id: 'user-1',
  tenantId: 'tenant-1',
  role: 'CREDIT_OFFICER' as const,
};

describe('TokenService cell scoping', () => {
  const af = serviceFor('af-south-1');
  const eu = serviceFor('eu-west-3');

  it('issues tenant and platform tokens with the issuing cell and accepts them there', () => {
    const tenant = af.issueAccessToken(tenantUser).accessToken;
    const platform = af.issueAccessToken({ kind: 'PLATFORM_ADMIN', id: 'admin-1' }).accessToken;
    expect(af.verifyAccessToken(tenant)).toEqual(tenantUser);
    expect(af.verifyAccessToken(platform)).toEqual({ kind: 'PLATFORM_ADMIN', id: 'admin-1' });
  });

  it.each([
    ['tenant', tenantUser],
    ['platform', { kind: 'PLATFORM_ADMIN' as const, id: 'admin-1' }],
  ])('rejects a %s token from another cell with 421 and its home region', (_kind, principal) => {
    const token = af.issueAccessToken(principal).accessToken;
    let error: unknown;
    try {
      eu.verifyAccessToken(token);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MisdirectedRequestError);
    expect(error).toMatchObject({ status: 421, homeRegion: 'af-south-1' });
  });

  it('rejects a validly signed token without a cell claim', () => {
    const legacy = new JwtService({ secret: SECRET }).sign(
      { sub: 'user-1', aud: 'tenant', tid: 'tenant-1', role: 'CREDIT_OFFICER' },
      { issuer: 'test-issuer', expiresIn: 60, algorithm: 'HS256' },
    );
    expect(() => af.verifyAccessToken(legacy)).toThrow(UnauthenticatedError);
  });

  it('treats a foreign-cell token it cannot verify as a routing hint (421), never as access', () => {
    // Cells use different signing keys, so another region's genuine token fails verification.
    const otherCellToken = serviceFor('af-south-1', 'y'.repeat(64)).issueAccessToken(
      tenantUser,
    ).accessToken;
    expect(() => eu.verifyAccessToken(otherCellToken)).toThrow(MisdirectedRequestError);
  });

  it('rejects a token for THIS cell with a bad signature as unauthenticated (401)', () => {
    const forged = serviceFor('eu-west-3', 'y'.repeat(64)).issueAccessToken(tenantUser).accessToken;
    expect(() => eu.verifyAccessToken(forged)).toThrow(UnauthenticatedError);
  });

  it('ignores an unverifiable cell hint for a region that is not a configured cell (401)', () => {
    const untrusted = serviceFor('ap-south-9', 'y'.repeat(64)).issueAccessToken(
      tenantUser,
    ).accessToken;
    expect(() => eu.verifyAccessToken(untrusted)).toThrow(UnauthenticatedError);
  });

  it('reports the issue time with millisecond precision', () => {
    const before = Date.now();
    const { issuedAtMs } = af.verify(af.issueAccessToken(tenantUser).accessToken);
    expect(issuedAtMs).toBeGreaterThanOrEqual(before);
    expect(issuedAtMs).toBeLessThanOrEqual(Date.now());
  });
});
