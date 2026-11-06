import { Inject, Injectable, Logger } from '@nestjs/common';

import { ConflictError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';

import { TENANT_DIRECTORY, type TenantDirectory } from './tenant-directory.port';

/**
 * Global slug uniqueness across cells (SPEC §4.1). Platform registration calls `reserve`
 * BEFORE committing the new institution: a conditional put of a `PENDING` directory row for
 * this cell. A slug already held anywhere else (another cell's tenant, or a reservation in
 * flight there) is rejected with 409 DUPLICATE, exactly like a local duplicate. If the
 * registration then fails, `release` deletes the reservation (best effort; a leftover
 * `PENDING` row of this cell is harmless — it is invisible to lookups and this cell may
 * re-reserve it). Once committed, the worker's projection replaces it with the real entry.
 */
@Injectable()
export class SlugReservations {
  private readonly logger = new Logger(SlugReservations.name);

  constructor(
    @Inject(TENANT_DIRECTORY) private readonly directory: TenantDirectory,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  async reserve(slug: string, institutionId: string): Promise<void> {
    const result = await this.directory.reserve({
      slug,
      institutionId,
      homeRegion: this.config.CELL_REGION,
      apiBaseUrl: new URL(this.config.CELL_API_BASE_URL).origin,
    });
    if (result === 'taken') {
      throw new ConflictError(ErrorCode.DUPLICATE, `Slug ${slug} is already registered`);
    }
  }

  async release(slug: string, institutionId: string): Promise<void> {
    try {
      await this.directory.release(slug, institutionId);
    } catch (err) {
      this.logger.warn(`Slug reservation release failed for ${slug}: ${String(err)}`);
    }
  }
}
