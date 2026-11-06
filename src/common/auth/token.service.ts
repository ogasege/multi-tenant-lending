import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { APP_CONFIG } from '../../config/config.module';
import { trustedCellOrigin } from '../../config/cell-origins';
import type { Env } from '../../config/env.schema';
import type { Principal } from '../context/request-context';
import type { UserRole } from '../database/schema';
import { MisdirectedRequestError, UnauthenticatedError } from '../errors/app-error';

export type Audience = 'tenant' | 'platform';

interface AccessClaims {
  sub: string;
  aud: Audience;
  tid?: string;
  role?: UserRole;
  /** Region of the issuing cell (SPEC §4.1). Tokens are only valid in that cell. */
  cell?: string;
  /**
   * Issue time in epoch MILLISECONDS (`iat` only has seconds). Compared with the principal's
   * revocation epoch, so a token issued just before a revocation is rejected while one issued
   * just after it (same second) is accepted.
   */
  iat_ms?: number;
  iat?: number;
}

/** A verified access token: who it authenticates and when it was issued. */
export interface VerifiedAccessToken {
  principal: Principal;
  /** Epoch milliseconds. */
  issuedAtMs: number;
}

/**
 * Short-lived (15 min) HS256 access tokens. The tenant id travels in the signed `tid` claim and
 * is the ONLY source of tenant context for authenticated requests. Audiences separate platform
 * administrators from tenant users so one can never be replayed as the other.
 *
 * Every token is cell-scoped by its `cell` claim (the issuing region): a cell only holds its
 * own tenants' data, and platform administrators also operate per cell. A token presented to
 * another cell is rejected with 421 Misdirected Request (`MisdirectedRequestError`).
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  issueAccessToken(principal: Principal): { accessToken: string; expiresIn: number } {
    const issuedAtMs = Date.now();
    const claims: AccessClaims =
      principal.kind === 'PLATFORM_ADMIN'
        ? { sub: principal.id, aud: 'platform', cell: this.config.CELL_REGION, iat_ms: issuedAtMs }
        : {
            sub: principal.id,
            aud: 'tenant',
            tid: principal.tenantId,
            role: principal.role,
            cell: this.config.CELL_REGION,
            iat_ms: issuedAtMs,
          };
    const accessToken = this.jwt.sign(claims, {
      issuer: this.config.JWT_ISSUER,
      expiresIn: this.config.JWT_ACCESS_TTL_SECONDS,
      jwtid: randomUUID(),
      algorithm: 'HS256',
    });
    return { accessToken, expiresIn: this.config.JWT_ACCESS_TTL_SECONDS };
  }

  verifyAccessToken(token: string): Principal {
    return this.verify(token).principal;
  }

  /** Verifies a token and also returns its issue time (for revocation checks). */
  verify(token: string): VerifiedAccessToken {
    let claims: AccessClaims;
    try {
      claims = this.jwt.verify<AccessClaims>(token, {
        issuer: this.config.JWT_ISSUER,
        audience: ['tenant', 'platform'],
        algorithms: ['HS256'], // pin the algorithm: rejects alg=none / key-confusion attacks
      });
    } catch {
      // Each cell signs with its OWN secret (no shared key across regions), so a genuine token
      // from another cell fails verification here. Its unverified `cell` claim is used purely
      // as a routing hint — never for authorisation: the response only points to that cell's
      // public URL (already public via the directory) and grants nothing.
      const hinted = this.unverifiedCell(token);
      if (hinted && hinted !== this.config.CELL_REGION) throw new MisdirectedRequestError(hinted);
      throw new UnauthenticatedError();
    }
    if (!claims.cell) throw new UnauthenticatedError();
    if (claims.cell !== this.config.CELL_REGION) throw new MisdirectedRequestError(claims.cell);
    const issuedAtMs = typeof claims.iat_ms === 'number' ? claims.iat_ms : (claims.iat ?? 0) * 1000;
    if (claims.aud === 'platform') {
      return { principal: { kind: 'PLATFORM_ADMIN', id: claims.sub }, issuedAtMs };
    }
    if (!claims.tid || !claims.role) throw new UnauthenticatedError();
    return {
      principal: { kind: 'USER', id: claims.sub, tenantId: claims.tid, role: claims.role },
      issuedAtMs,
    };
  }

  /**
   * The unverified `cell` claim, but only when it names a cell configured as trusted
   * (`CELL_ORIGINS` / `CELL_ORIGIN_SUFFIX`); anything else is a plain 401 and triggers no
   * directory lookup.
   */
  private unverifiedCell(token: string): string | undefined {
    const decoded: unknown = this.jwt.decode(token);
    if (typeof decoded !== 'object' || decoded === null || !('cell' in decoded)) return undefined;
    const cell = decoded.cell;
    if (typeof cell !== 'string') return undefined;
    return trustedCellOrigin(this.config, cell) ? cell : undefined;
  }
}
