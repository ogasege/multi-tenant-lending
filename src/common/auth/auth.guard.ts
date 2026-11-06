import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import type { RequestContextStore } from '../context/request-context';
import {
  AppError,
  ForbiddenError,
  MisdirectedRequestError,
  UnauthenticatedError,
} from '../errors/app-error';
import { ErrorCode } from '../errors/error-codes';

import { AccessRevocations } from './access-revocations';
import { CELL_LOCATOR, type CellLocator } from './cell-locator';
import {
  ANY_TENANT_USER,
  type AnyTenantUserOptions,
  IS_PUBLIC,
  PLATFORM_ONLY,
  REQUIRED_PERMISSIONS,
} from './decorators';
import { Permission, roleHas } from './permissions';
import { TokenService, type VerifiedAccessToken } from './token.service';

/**
 * Read-only permissions. When the revocation store (Redis) is unreachable, a route fails
 * OPEN (served, with a warning) only if EVERY permission it requires is in this list, or it
 * is an `@AnyTenantUser()` route requiring none. Every other route fails CLOSED (503): a
 * revoked or demoted user must never keep a write capability (money movement, credit
 * decisions, user/institution/product management, operations) on a stale token. A new
 * permission is therefore fail-closed until it is deliberately added here.
 */
export const READ_ONLY_FAIL_OPEN_PERMISSIONS: readonly Permission[] = [
  Permission.PRODUCT_READ,
  Permission.CUSTOMER_READ,
  Permission.APPLICATION_READ,
  Permission.LOAN_READ,
  Permission.LEDGER_READ,
  Permission.AUDIT_READ,
];

/**
 * Global guard, deny-by-default:
 *  1. `@Public()` routes pass;
 *  2. otherwise a valid Bearer access token is required — it sets the principal and the tenant
 *     context (from the signed `tid` claim) for the rest of the request;
 *  3. `@PlatformAdminOnly()` routes need a platform token; every other route needs a tenant
 *     token AND every permission listed in `@RequirePermissions()`. `@AnyTenantUser()` is
 *     the explicit opt-in for routes any tenant user may call (optionally platform admins
 *     too); it still needs a valid token and the revocation check;
 *  4. tenant tokens are checked against `AccessRevocations` (role change, disable,
 *     suspension take effect immediately). If Redis is unavailable the check fails open, with
 *     a warning, only for read-only routes ({@link READ_ONLY_FAIL_OPEN_PERMISSIONS} and
 *     `@AnyTenantUser()` routes) and closed (503) for everything else.
 * A tenant route with neither `@RequirePermissions()` nor `@AnyTenantUser()` is rejected, so
 * forgetting the decorator fails closed instead of open.
 * A token issued by another cell fails with 421 Misdirected Request, enriched with that
 * cell's API base URL when a `CellLocator` (the tenant directory) is registered.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly cls: ClsService<RequestContextStore>,
    private readonly revocations: AccessRevocations,
    @Optional() @Inject(CELL_LOCATOR) private readonly cells?: CellLocator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets)) return true;

    const header = context.switchToHttp().getRequest<Request>().header('authorization');
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) throw new UnauthenticatedError();

    let verified: VerifiedAccessToken;
    try {
      verified = this.tokens.verify(token);
    } catch (err) {
      if (err instanceof MisdirectedRequestError) return this.rejectMisdirected(err);
      throw err;
    }
    const { principal } = verified;
    this.cls.set('principal', principal);

    if (this.reflector.getAllAndOverride<boolean | undefined>(PLATFORM_ONLY, targets)) {
      if (principal.kind !== 'PLATFORM_ADMIN') throw new ForbiddenError();
      return true;
    }

    const anyTenantUser = this.reflector.getAllAndOverride<
      Required<AnyTenantUserOptions> | undefined
    >(ANY_TENANT_USER, targets);
    if (principal.kind === 'PLATFORM_ADMIN' && anyTenantUser?.allowPlatformAdmin) return true;

    if (principal.kind !== 'USER') throw new ForbiddenError();
    this.cls.set('tenantId', principal.tenantId);

    const required =
      this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, targets) ??
      [];
    if (required.length === 0 && !anyTenantUser) throw new ForbiddenError();
    if (!required.every((p) => roleHas(principal.role, p))) throw new ForbiddenError();

    await this.assertNotRevoked(principal.id, principal.tenantId, verified.issuedAtMs, required);
    return true;
  }

  private async assertNotRevoked(
    principalId: string,
    tenantId: string,
    issuedAtMs: number,
    required: readonly Permission[],
  ): Promise<void> {
    let state;
    try {
      state = await this.revocations.check(principalId, tenantId, issuedAtMs);
    } catch (err) {
      // `required` is empty only on `@AnyTenantUser()` routes (checked by the caller).
      if (required.every((p) => READ_ONLY_FAIL_OPEN_PERMISSIONS.includes(p))) {
        this.logger.warn(`Revocation check unavailable; failing open (read-only): ${String(err)}`);
        return;
      }
      this.logger.error(`Revocation check unavailable; failing closed: ${String(err)}`);
      throw new AppError(
        503,
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'Authorisation could not be verified; retry shortly',
      );
    }
    if (state === 'revoked') throw new UnauthenticatedError();
    if (state === 'suspended') {
      throw new ForbiddenError(ErrorCode.INSTITUTION_SUSPENDED, 'This institution is suspended');
    }
  }

  /** Adds the home cell's base URL (from the directory) to a 421; best effort. */
  private async rejectMisdirected(err: MisdirectedRequestError): Promise<never> {
    const apiBaseUrl = await this.cells?.apiBaseUrlFor(err.homeRegion).catch(() => undefined);
    throw new MisdirectedRequestError(err.homeRegion, apiBaseUrl ?? err.apiBaseUrl);
  }
}
