import { createParamDecorator, SetMetadata } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';

import type { Principal, RequestContextStore } from '../context/request-context';
import { ForbiddenError, UnauthenticatedError } from '../errors/app-error';

import type { Permission } from './permissions';

export const IS_PUBLIC = 'isPublic';
export const REQUIRED_PERMISSIONS = 'requiredPermissions';
export const PLATFORM_ONLY = 'platformOnly';

/** Opt a route out of authentication (everything else is denied by default). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route requires a tenant user holding ALL listed permissions. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Route is reserved for platform administrators (aud=platform tokens). */
export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ONLY, true);

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
