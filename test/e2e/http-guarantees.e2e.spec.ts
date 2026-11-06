import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import request from 'supertest';

import { RequirePermissions } from '@/common/auth/decorators';
import { Permission } from '@/common/auth/permissions';
import { TokenService } from '@/common/auth/token.service';
import { TransactionRunner } from '@/common/database/transaction-runner';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCode } from '@/common/errors/error-codes';
import { Idempotent } from '@/common/idempotency/idempotency.interceptor';

import { createTestApp, type TestApp } from '../setup/app';

class ChargeDto {
  @IsInt()
  @Min(1)
  amount!: number;
}

let executions = 0;

/** Test-only routes exercising the global guard, interceptor, pipe and filter. */
@Controller('probe')
class ProbeController {
  @Post('charge')
  @Idempotent()
  @RequirePermissions(Permission.REPAYMENT_CREATE)
  async charge(@Body() dto: ChargeDto): Promise<{ executions: number; amount: number }> {
    executions += 1;
    await new Promise((r) => setTimeout(r, dto.amount === 999 ? 300 : 0));
    if (dto.amount === 13) {
      throw new BusinessRuleError(ErrorCode.REPAYMENT_EXCEEDS_PAYOFF, 'Too much');
    }
    return { executions, amount: dto.amount };
  }

  @Get('no-permissions-declared')
  forgotten(): string {
    return 'should never be reachable';
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('HTTP guarantees (auth, idempotency, validation, errors)', () => {
  let t: TestApp;
  let financeToken: string;
  let auditorToken: string;
  const tenantId = randomUUID();

  beforeAll(async () => {
    t = await createTestApp([ProbeModule]);
    await t.app.get(TransactionRunner).asPlatformAdmin(
      (tx) =>
        tx
          .insertInto('institutions')
          .values({
            id: tenantId,
            slug: `probe-${tenantId.slice(0, 8)}`,
            legal_name: 'Probe MFB',
            country_code: 'NG',
            default_currency: 'NGN',
            supported_currencies: ['NGN'],
            lender_type: 'MICROFINANCE_BANK',
            home_region: process.env.AWS_REGION ?? 'af-south-1',
          })
          .execute(),
      { tenantId },
    );
    const tokens = t.app.get(TokenService);
    financeToken = tokens.issueAccessToken({
      kind: 'USER',
      id: randomUUID(),
      tenantId,
      role: 'FINANCE_OFFICER',
    }).accessToken;
    auditorToken = tokens.issueAccessToken({
      kind: 'USER',
      id: randomUUID(),
      tenantId,
      role: 'AUDITOR',
    }).accessToken;
  });

  const extraApps: TestApp[] = [];

  afterAll(async () => {
    await Promise.all([t.close(), ...extraApps.map((app) => app.close())]);
  });

  const charge = (body: unknown, key?: string, token = financeToken) => {
    const req = request(t.http).post('/v1/probe/charge').set('Authorization', `Bearer ${token}`);
    return (key ? req.set('Idempotency-Key', key) : req).send(body as object);
  };

  describe('authentication & authorisation', () => {
    it('denies requests without a token (deny by default)', async () => {
      const res = await request(t.http).post('/v1/probe/charge').send({ amount: 1 }).expect(401);
      expect(res.body.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a tampered token', async () => {
      await request(t.http)
        .post('/v1/probe/charge')
        .set('Authorization', `Bearer ${financeToken.slice(0, -2)}xx`)
        .send({ amount: 1 })
        .expect(401);
    });

    it('denies a role without the required permission', async () => {
      const res = await charge({ amount: 1 }, randomUUID(), auditorToken).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('fails closed when a route forgets to declare permissions', async () => {
      await request(t.http)
        .get('/v1/probe/no-permissions-declared')
        .set('Authorization', `Bearer ${financeToken}`)
        .expect(403);
    });
  });

  describe('serving cell header', () => {
    it('names the serving cell on every response, errors included', async () => {
      const region = process.env.CELL_REGION ?? process.env.AWS_REGION ?? 'af-south-1';
      const denied = await request(t.http).post('/v1/probe/charge').send({}).expect(401);
      expect(denied.headers['x-tenant-cell']).toBe(region);
      const ok = await charge({ amount: 2 }, randomUUID()).expect(201);
      expect(ok.headers['x-tenant-cell']).toBe(region);
    });

    it('exposes it to browsers through CORS', async () => {
      // Closed in afterAll: closing a Nest app resets nestjs-cls process-wide.
      extraApps.push(await createTestApp([], { CORS_ORIGINS: 'http://demo.test' }));
      const res = await request(extraApps[0]!.http)
        .get('/v1/no-such-route')
        .set('Origin', 'http://demo.test')
        .expect(404);
      expect(res.headers['access-control-allow-origin']).toBe('http://demo.test');
      expect(res.headers['access-control-expose-headers']).toContain('X-Tenant-Cell');
    });
  });

  describe('validation', () => {
    it('rejects unknown properties (mass assignment) with field-level problem details', async () => {
      const res = await charge({ amount: 5, tenantId: randomUUID() }, randomUUID()).expect(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
      expect(res.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'tenantId' })]),
      );
    });
  });

  describe('idempotency', () => {
    it('requires an Idempotency-Key on money-moving routes', async () => {
      const res = await charge({ amount: 5 }).expect(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('executes once and replays the stored response for a retried request', async () => {
      const key = randomUUID();
      const first = await charge({ amount: 10 }, key).expect(201);
      const second = await charge({ amount: 10 }, key).expect(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(second.body.executions).toBe(first.body.executions);
    });

    it('rejects reuse of a key with a different request body (422)', async () => {
      const key = randomUUID();
      await charge({ amount: 10 }, key).expect(201);
      const res = await charge({ amount: 11 }, key).expect(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('serialises a concurrent duplicate: it waits, then replays — the handler runs once', async () => {
      const key = randomUUID();
      const before = executions;
      // supertest only sends on .then(): start both requests at once.
      const [a, b] = await Promise.all([
        charge({ amount: 999 }, key).then((r) => r),
        charge({ amount: 999 }, key).then((r) => r),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(executions - before).toBe(1);
      expect([a.headers['idempotent-replayed'], b.headers['idempotent-replayed']]).toContain(
        'true',
      );
      expect(a.body).toEqual(b.body);
    });

    it('releases the key when the request fails, so a corrected retry can proceed', async () => {
      const key = randomUUID();
      const failed = await charge({ amount: 13 }, key).expect(422);
      expect(failed.body).toMatchObject({
        code: 'REPAYMENT_EXCEEDS_PAYOFF',
        type: 'https://docs.10mg.ai/errors/repayment-exceeds-payoff',
      });
      // Same key, same body: re-executed (not replayed), because failures are not stored.
      const retry = await charge({ amount: 13 }, key).expect(422);
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
    });
  });
});
