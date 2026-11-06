import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { ClsService } from 'nestjs-cls';

import type { Env } from '../../config/env.schema';
import type { RequestContextStore } from '../context/request-context';

import type { AccessRevocations, AccessState } from './access-revocations';
import { AuthGuard } from './auth.guard';
import { REQUIRED_PERMISSIONS } from './decorators';
import { Permission } from './permissions';
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

function contextFor(required: Permission[]): ExecutionContext {
  const handler = () => undefined;
  Reflect.defineMetadata(REQUIRED_PERMISSIONS, required, handler);
  const token = tokens.issueAccessToken(user).accessToken;
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

  it.each([Permission.LOAN_DISBURSE, Permission.REPAYMENT_CREATE])(
    'fails CLOSED (503) on %s when Redis is unavailable',
    async (permission) => {
      await expect(guardWith(down).canActivate(contextFor([permission]))).rejects.toMatchObject({
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
      });
    },
  );

  it('fails open on read routes when Redis is unavailable', async () => {
    await expect(guardWith(down).canActivate(contextFor([Permission.LEDGER_READ]))).resolves.toBe(
      true,
    );
  });
});
