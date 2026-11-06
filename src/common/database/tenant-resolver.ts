import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { TransactionRunner } from './transaction-runner';

export interface ResolvedInstitution {
  id: string;
  status: 'ACTIVE' | 'SUSPENDED';
}

/**
 * Sentinel tenant that owns no rows: pinning it makes every RLS-protected table read as empty,
 * so the lookup transaction can do nothing except call the SECURITY DEFINER functions below.
 */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * Pre-tenant lookups for public routes, through the two narrow SECURITY DEFINER functions
 * created in V1__core_schema.sql. They are the only reads allowed before a tenant context
 * exists, and each reveals just the tenant id (and status) it needs; everything else then runs
 * inside `TransactionRunner.runForTenant` under RLS.
 */
@Injectable()
export class TenantResolver {
  constructor(private readonly runner: TransactionRunner) {}

  async institutionBySlug(slug: string): Promise<ResolvedInstitution | undefined> {
    const { rows } = await this.runner.runForTenant(NO_TENANT, (tx) =>
      sql<ResolvedInstitution>`SELECT id, status FROM resolve_institution(${slug})`.execute(tx),
    );
    return rows[0];
  }

  /** Tenant that issued a refresh token (looked up by its hash). */
  async refreshTokenTenant(tokenHash: string): Promise<string | undefined> {
    const { rows } = await this.runner.runForTenant(NO_TENANT, (tx) =>
      sql<{
        tenant_id: string;
      }>`SELECT tenant_id FROM resolve_refresh_token(${tokenHash})`.execute(tx),
    );
    return rows[0]?.tenant_id;
  }
}
