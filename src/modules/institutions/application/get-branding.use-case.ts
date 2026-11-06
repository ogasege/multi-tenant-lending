import { Injectable } from '@nestjs/common';

import { TransactionRunner } from '../../../common/database/transaction-runner';
import { NotFoundError } from '../../../common/errors/app-error';
import { BrandingAssets } from '../infrastructure/branding-assets';
import { InstitutionsRepository } from '../infrastructure/institutions.repository';

import { type BrandingView, toBrandingView } from './branding.view';

/** The caller's branding, including the `version` needed for a subsequent PUT. */
@Injectable()
export class GetBranding {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: InstitutionsRepository,
    private readonly assets: BrandingAssets,
  ) {}

  async execute(): Promise<BrandingView> {
    const row = await this.runner.run((tx) => this.repo.findBranding(tx));
    if (!row) throw new NotFoundError('Branding');
    return toBrandingView(row, this.assets);
  }
}
