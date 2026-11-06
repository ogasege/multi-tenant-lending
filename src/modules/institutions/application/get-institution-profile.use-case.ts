import { Injectable } from '@nestjs/common';

import type { LenderType } from '../../../common/database/schema';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { InstitutionsRepository } from '../infrastructure/institutions.repository';

export interface InstitutionProfileView {
  id: string;
  slug: string;
  legalName: string;
  countryCode: string;
  defaultCurrency: string;
  supportedCurrencies: string[];
  timezone: string;
  lenderType: LenderType;
  maxAprBps: number | null;
  status: 'ACTIVE' | 'SUSPENDED';
}

/**
 * The caller's own institution profile. Read-only: regulatory and lifecycle fields
 * (lender type, APR cap, status, slug) are platform-controlled, and RLS grants tenants
 * SELECT only on `institutions` (migration 0002).
 */
@Injectable()
export class GetInstitutionProfile {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: InstitutionsRepository,
  ) {}

  async execute(): Promise<InstitutionProfileView> {
    const row = await this.runner.run((tx) => this.repo.findInstitution(tx));
    if (!row) throw new NotFoundError('Institution');
    return {
      id: row.id,
      slug: row.slug,
      legalName: row.legal_name,
      countryCode: row.country_code,
      defaultCurrency: row.default_currency,
      supportedCurrencies: row.supported_currencies,
      timezone: row.timezone,
      lenderType: row.lender_type,
      maxAprBps: row.max_apr_bps,
      status: row.status,
    };
  }
}
