import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import { PasswordService } from '../../../common/auth/password.service';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import {
  BusinessRuleError,
  ConflictError,
  ValidationError,
} from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { assertCurrency, type CurrencyCode } from '../../../common/money/currency';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import { SlugReservations } from '../../directory/application/slug-reservations';
import { CHART_OF_ACCOUNTS } from '../../ledger/chart-of-accounts';

import {
  InstitutionDto,
  type RegisterInstitutionDto,
  RegisteredInstitutionDto,
} from './institution.dto';

/**
 * Onboards a new tenant in ONE transaction (SPEC §4, §8): institution, branding, a chart of
 * accounts per supported currency, the first INSTITUTION_ADMIN, the audit entry (in the new
 * tenant's chain) and the `institution.registered` event. Runs in platform scope with the new
 * tenant pinned so tenant rows pass the normal RLS `WITH CHECK`.
 *
 * Slugs are unique across ALL cells: before the transaction the slug is reserved in the
 * global tenant directory (`SlugReservations`, a conditional `PENDING` row for this cell); a
 * slug homed in another cell is rejected with 409 DUPLICATE. If anything fails afterwards,
 * the reservation is released (best effort). If the directory is unreachable, registration
 * fails rather than risk a cross-cell duplicate.
 */
@Injectable()
export class RegisterInstitution {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly passwords: PasswordService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly slugs: SlugReservations,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  async execute(dto: RegisterInstitutionDto): Promise<RegisteredInstitutionDto> {
    // Data residency: a cell only ever stores tenants homed in its own region.
    if (dto.homeRegion !== this.config.CELL_REGION) {
      throw new BusinessRuleError(
        ErrorCode.WRONG_CELL,
        `This cell serves ${this.config.CELL_REGION}; register the institution in its home cell`,
        { homeRegion: dto.homeRegion, cellRegion: this.config.CELL_REGION },
      );
    }
    const currencies = [...new Set(dto.supportedCurrencies.map((c) => assertCurrency(c)))];
    const defaultCurrency = assertCurrency(dto.defaultCurrency);
    if (!currencies.includes(defaultCurrency)) {
      throw new ValidationError('defaultCurrency must be one of supportedCurrencies', [
        { field: 'defaultCurrency', message: 'must be one of supportedCurrencies' },
      ]);
    }

    // Hash outside the transaction: argon2 is deliberately slow and must not hold locks.
    const passwordHash = await this.passwords.hash(dto.firstAdmin.password);
    const tenantId = randomUUID();

    await this.slugs.reserve(dto.slug, tenantId);
    try {
      return await this.persist(dto, tenantId, passwordHash, currencies, defaultCurrency);
    } catch (err) {
      await this.slugs.release(dto.slug, tenantId);
      throw err;
    }
  }

  private persist(
    dto: RegisterInstitutionDto,
    tenantId: string,
    passwordHash: string,
    currencies: CurrencyCode[],
    defaultCurrency: CurrencyCode,
  ): Promise<RegisteredInstitutionDto> {
    return this.runner.asPlatformAdmin(
      async (tx) => {
        const taken = await tx
          .selectFrom('institutions')
          .select('id')
          .where('slug', '=', dto.slug)
          .executeTakeFirst();
        if (taken) {
          throw new ConflictError(ErrorCode.DUPLICATE, `Slug ${dto.slug} is already registered`);
        }

        const institution = await tx
          .insertInto('institutions')
          .values({
            id: tenantId,
            slug: dto.slug,
            legal_name: dto.legalName.trim(),
            country_code: dto.countryCode,
            default_currency: defaultCurrency,
            supported_currencies: currencies,
            lender_type: dto.lenderType,
            max_apr_bps: dto.maxAprBps ?? null,
            timezone: dto.timezone,
            home_region: dto.homeRegion,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const branding = await tx
          .insertInto('institution_branding')
          .values({
            tenant_id: tenantId,
            display_name: dto.branding.displayName.trim(),
            primary_color: dto.branding.primaryColor,
            secondary_color: dto.branding.secondaryColor,
            locale: dto.branding.locale,
          })
          .returning(['display_name', 'primary_color', 'secondary_color', 'locale'])
          .executeTakeFirstOrThrow();

        const accounts = currencies.flatMap((currency) =>
          CHART_OF_ACCOUNTS.map((a) => ({
            tenant_id: tenantId,
            code: a.code,
            name: a.name,
            type: a.type,
            normal_balance: a.normalBalance,
            currency,
          })),
        );
        await tx.insertInto('ledger_accounts').values(accounts).execute();

        const admin = await tx
          .insertInto('users')
          .values({
            tenant_id: tenantId,
            email: dto.firstAdmin.email,
            full_name: dto.firstAdmin.fullName.trim(),
            password_hash: passwordHash,
            role: 'INSTITUTION_ADMIN',
          })
          .returning(['id', 'email', 'full_name', 'role'])
          .executeTakeFirstOrThrow();

        const result: RegisteredInstitutionDto = Object.assign(InstitutionDto.from(institution), {
          branding: {
            displayName: branding.display_name,
            primaryColor: branding.primary_color,
            secondaryColor: branding.secondary_color,
            locale: branding.locale,
          },
          firstAdmin: {
            id: admin.id,
            email: admin.email,
            fullName: admin.full_name,
            role: admin.role,
          },
          ledgerAccountsCreated: accounts.length,
        });

        await this.audit.record(tx, {
          tenantId,
          action: 'institution.registered',
          entityType: 'institution',
          entityId: tenantId,
          after: result,
        });
        await this.outbox.publish(tx, {
          tenantId,
          type: 'institution.registered',
          aggregateType: 'institution',
          aggregateId: tenantId,
          data: {
            institutionId: tenantId,
            slug: institution.slug,
            lenderType: institution.lender_type,
            supportedCurrencies: currencies,
            homeRegion: dto.homeRegion,
          },
        });
        return result;
      },
      { tenantId },
    );
  }
}
