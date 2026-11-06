import { createParamDecorator, SetMetadata } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';

import type { Principal, RequestContextStore } from '../context/request-context';
import { ForbiddenError, UnauthenticatedError } from '../errors/app-error';

import type { Permission } from './permissions';

export const IS_PUBLIC = 'isPublic';
export const REQUIRED_PERMISSIONS = 'requiredPermissions';
export const PLATFORM_ONLY = 'platformOnly';
export const ANY_TENANT_USER = 'anyTenantUser';

/** Opt a route out of authentication (everything else is denied by default). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route requires a tenant user holding ALL listed permissions. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Route is reserved for platform administrators (aud=platform tokens). */
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ONLY, true);

export interface AnyTenantUserOptions {
  /** Also admit platform administrators (aud=platform tokens). Default `false`. */
  allowPlatformAdmin?: boolean;
}

/**
 * Explicit opt-in: the route serves ANY signed-in tenant user, whatever the role, without a
 * specific permission (e.g. `GET /v1/me`, the caller's own institution profile).
 *
 * Why this is safe, and still deny-by-default:
 * - it is an explicit, greppable marker, like `@Public()`; a route with neither it nor
 *   `@RequirePermissions()` is still rejected by the guard;
 * - authentication is unchanged: a valid tenant token is required, it pins the tenant
 *   context (RLS), and the revocation check still runs (a disabled user gets 401);
 * - it grants no capability: handlers behind it may only return data scoped to the caller
 *   (their own user record or their own tenant's non-sensitive profile). Anything that
 *   reads other records or changes state must declare a permission instead;
 * - `@RequirePermissions()` on the same route still applies on top of it.
 */
export const AnyTenantUser = (options: AnyTenantUserOptions = {}) =>
  SetMetadata(ANY_TENANT_USER, {
    allowPlatformAdmin: options.allowPlatformAdmin ?? false,
  } satisfies Required<AnyTenantUserOptions>);

/** Injects the authenticated principal. */
export const CurrentPrincipal = createParamDecorator((): Principal => {
  const principal = ClsServiceManager.getClsService<RequestContextStore>().get('principal');
  if (!principal) throw new UnauthenticatedError();
  return principal;
});

export type TenantUser = Extract<Principal, { kind: 'USER' }>;

/**
 * Injects the authenticated tenant user on tenant routes. The guard already rejects platform
 * tokens there (403); this repeats that check so handlers get the narrowed type.
 */
export const CurrentTenantUser = createParamDecorator((): TenantUser => {
  const principal = ClsServiceManager.getClsService<RequestContextStore>().get('principal');
  if (!principal) throw new UnauthenticatedError();
  if (principal.kind !== 'USER') throw new ForbiddenError();
  return principal;
});
