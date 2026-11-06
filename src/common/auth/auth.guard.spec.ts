import { type ExecutionContext, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { ClsService } from 'nestjs-cls';

import type { Env } from '../../config/env.schema';
import type { Principal, RequestContextStore } from '../context/request-context';

import type { AccessRevocations, AccessState } from './access-revocations';
import { AuthGuard, READ_ONLY_FAIL_OPEN_PERMISSIONS } from './auth.guard';
import { ANY_TENANT_USER, REQUIRED_PERMISSIONS } from './decorators';
import { Permission, ROLE_PERMISSIONS } from './permissions';
import { TokenService } from './token.service';

const tokens = new TokenService(new JwtService({ secret: 'x'.repeat(64) }), {
  JWT_ISSUER: 'test',
  JWT_ACCESS_TTL_SECONDS: 900,
  CELL_REGION: 'af-south-1',
  CELL_API_BASE_URL: 'https://af.api.test',
} as Partial<Env> as Env);

const user = {
  kind: 'USER' as const,
  id: '7b0c6c1e-0000-4000-8000-000000000001',
  tenantId: '7b0c6c1e-0000-4000-8000-000000000002',
  role: 'FINANCE_OFFICER' as const,
};

interface RouteMeta {
  anyTenantUser?: { allowPlatformAdmin: boolean };
  principal?: Principal;
}

function contextFor(required: Permission[], meta: RouteMeta = {}): ExecutionContext {
  const handler = () => undefined;
  if (required.length > 0) Reflect.defineMetadata(REQUIRED_PERMISSIONS, required, handler);
  if (meta.anyTenantUser) Reflect.defineMetadata(ANY_TENANT_USER, meta.anyTenantUser, handler);
  const token = tokens.issueAccessToken(meta.principal ?? user).accessToken;
  return {
    getHandler: () => handler,
    getClass: () => Object,
    switchToHttp: () => ({
      getRequest: () => ({ header: () => `Bearer ${token}` }),
    }),
  } as unknown as ExecutionContext;
}

function guardWith(check: () => Promise<AccessState>): AuthGuard {
  const cls = { set: () => undefined } as unknown as ClsService<RequestContextStore>;
  const revocations = { check } as unknown as AccessRevocations;
  return new AuthGuard(new Reflector(), tokens, cls, revocations);
}

const down = () => Promise.reject(new Error('ECONNREFUSED'));

describe('AuthGuard revocation checks', () => {
  it('rejects a revoked token (role change / disable) with 401', async () => {
    const guard = guardWith(() => Promise.resolve('revoked'));
    await expect(guard.canActivate(contextFor([Permission.LEDGER_READ]))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a suspended tenant with 403 INSTITUTION_SUSPENDED', async () => {
    const guard = guardWith(() => Promise.resolve('suspended'));
    await expect(guard.canActivate(contextFor([Permission.LEDGER_READ]))).rejects.toMatchObject({
      status: 403,
      code: 'INSTITUTION_SUSPENDED',
    });
  });

  const admin = { ...user, role: 'INSTITUTION_ADMIN' as const };
  const writes = Object.values(Permission).filter(
    (p) => !READ_ONLY_FAIL_OPEN_PERMISSIONS.includes(p),
  );

  it.each(writes)(
    'fails CLOSED (503) on write permission %s when Redis is unavailable',
    async (p) => {
      // Any role holding the permission; the role check runs before the revocation check.
      const role = (Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[]).find((r) =>
        ROLE_PERMISSIONS[r].includes(p),
      );
      const principal: Principal = { ...user, role: role ?? 'INSTITUTION_ADMIN' };
      await expect(
        guardWith(down).canActivate(contextFor([p], { principal })),
      ).rejects.toMatchObject({ status: 503, code: 'UPSTREAM_UNAVAILABLE' });
    },
  );

  it('fails CLOSED when a read is combined with a write permission', async () => {
    await expect(
      guardWith(down).canActivate(
        contextFor([Permission.LOAN_READ, Permission.LOAN_DISBURSE], { principal: user }),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it.each(READ_ONLY_FAIL_OPEN_PERMISSIONS)(
    'fails open, with a warning, on read permission %s when Redis is unavailable',
    async (p) => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await expect(guardWith(down).canActivate(contextFor([p]))).resolves.toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failing open'));
      warn.mockRestore();
    },
  );

  it('keeps the user:manage capability of a revoked admin closed during an outage', async () => {
    await expect(
      guardWith(down).canActivate(contextFor([Permission.USER_MANAGE], { principal: admin })),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('AuthGuard @AnyTenantUser()', () => {
  const ok = () => Promise.resolve<AccessState>('valid');
  const platform = { kind: 'PLATFORM_ADMIN' as const, id: '7b0c6c1e-0000-4000-8000-000000000009' };

  it('admits any tenant role without a specific permission', async () => {
    const customer = { ...user, role: 'CUSTOMER' as const };
    await expect(
      guardWith(ok).canActivate(
        contextFor([], { anyTenantUser: { allowPlatformAdmin: false }, principal: customer }),
      ),
    ).resolves.toBe(true);
  });

  it('still rejects a route with neither permissions nor the opt-in (deny by default)', async () => {
    await expect(guardWith(ok).canActivate(contextFor([]))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('still runs the revocation check (revoked token → 401)', async () => {
    await expect(
      guardWith(() => Promise.resolve('revoked')).canActivate(
        contextFor([], { anyTenantUser: { allowPlatformAdmin: false } }),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('fails open when Redis is unavailable (read-only, own data)', async () => {
    await expect(
      guardWith(down).canActivate(contextFor([], { anyTenantUser: { allowPlatformAdmin: false } })),
    ).resolves.toBe(true);
  });

  it('admits platform admins only when allowPlatformAdmin is set', async () => {
    await expect(
      guardWith(ok).canActivate(
        contextFor([], { anyTenantUser: { allowPlatformAdmin: true }, principal: platform }),
      ),
    ).resolves.toBe(true);
    await expect(
      guardWith(ok).canActivate(
        contextFor([], { anyTenantUser: { allowPlatformAdmin: false }, principal: platform }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('still enforces @RequirePermissions() declared on the same route', async () => {
    await expect(
      guardWith(ok).canActivate(
        contextFor([Permission.USER_MANAGE], { anyTenantUser: { allowPlatformAdmin: false } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
