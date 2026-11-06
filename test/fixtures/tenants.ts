import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';

import { TokenService } from '@/common/auth/token.service';
import type { LenderType, UserRole } from '@/common/database/schema';
import { TransactionRunner } from '@/common/database/transaction-runner';
import { CHART_OF_ACCOUNTS } from '@/modules/ledger/chart-of-accounts';

export interface TestTenant {
  tenantId: string;
  slug: string;
  /** Access token per staff role (users are real rows in the tenant). */
  tokens: Record<Exclude<UserRole, 'CUSTOMER'>, string>;
  userIds: Record<Exclude<UserRole, 'CUSTOMER'>, string>;
}

const STAFF_ROLES = ['INSTITUTION_ADMIN', 'CREDIT_OFFICER', 'FINANCE_OFFICER', 'AUDITOR'] as const;

/**
 * Creates an institution directly in the database (as platform registration would: platform
 * scope + new tenant pinned), its chart of accounts, one staff user per role and their tokens.
 * Lets feature tests start from a ready tenant without depending on the platform module.
 */
export async function createTestTenant(
  app: INestApplication,
  opts: {
    currency?: 'NGN' | 'XOF';
    lenderType?: LenderType;
    maxAprBps?: number | null;
  } = {},
): Promise<TestTenant> {
  const tenantId = randomUUID();
  const slug = `lender-${tenantId.slice(0, 8)}`;
  const currency = opts.currency ?? 'NGN';
  const userIds = Object.fromEntries(
    STAFF_ROLES.map((r) => [r, randomUUID()]),
  ) as TestTenant['userIds'];

  await app.get(TransactionRunner).asPlatformAdmin(
    async (tx) => {
      await tx
        .insertInto('institutions')
        .values({
          id: tenantId,
          slug,
          legal_name: `${slug} Ltd`,
          country_code: currency === 'XOF' ? 'SN' : 'NG',
          default_currency: currency,
          supported_currencies: [currency],
          lender_type: opts.lenderType ?? 'MICROFINANCE_BANK',
          max_apr_bps: opts.maxAprBps ?? null,
          // The cell's own region, as platform registration enforces (SPEC §4.1).
          home_region: process.env.AWS_REGION ?? 'af-south-1',
        })
        .execute();
      await tx
        .insertInto('institution_branding')
        .values({ tenant_id: tenantId, display_name: `${slug} Credit` })
        .execute();
      await tx
        .insertInto('ledger_accounts')
        .values(
          CHART_OF_ACCOUNTS.map((a) => ({
            tenant_id: tenantId,
            code: a.code,
            name: a.name,
            type: a.type,
            normal_balance: a.normalBalance,
            currency,
          })),
        )
        .execute();
      await tx
        .insertInto('users')
        .values(
          STAFF_ROLES.map((role) => ({
            id: userIds[role],
            tenant_id: tenantId,
            email: `${role.toLowerCase()}@${slug}.test`,
            password_hash: 'not-used-in-token-fixtures',
            full_name: `${role} User`,
            role,
          })),
        )
        .execute();
    },
    { tenantId },
  );

  const tokenService = app.get(TokenService);
  const tokens = Object.fromEntries(
    STAFF_ROLES.map((role) => [
      role,
      tokenService.issueAccessToken({ kind: 'USER', id: userIds[role], tenantId, role })
        .accessToken,
    ]),
  ) as TestTenant['tokens'];

  return { tenantId, slug, tokens, userIds };
}
