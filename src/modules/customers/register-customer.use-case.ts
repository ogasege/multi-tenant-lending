import { Inject, Injectable } from '@nestjs/common';

import { AuditWriter } from '../../common/audit/audit-writer';
import { PasswordService } from '../../common/auth/password.service';
import { TenantSessions } from '../../common/auth/tenant-sessions';
import { nationalIdHmac } from '../../common/crypto/crypto';
import { TenantResolver } from '../../common/database/tenant-resolver';
import { TransactionRunner } from '../../common/database/transaction-runner';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/app-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { assertCurrency, type CurrencyCode } from '../../common/money/currency';
import { OutboxWriter } from '../../common/outbox/outbox-writer';
import { RateLimiterService } from '../../common/rate-limit/rate-limiter.service';
import { APP_CONFIG } from '../../config/config.module';
import type { Env } from '../../config/env.schema';

import {
  CustomerDto,
  type CustomerRegistrationDto,
  type RegisterCustomerDto,
} from './customer.dto';
import {
  IDENTITY_VERIFIER,
  type IdentityVerifier,
  isPastCalendarDate,
  type KycStatus,
  newCustomerReference,
} from './kyc';

/**
 * One answer for an existing national id OR email (OWASP ASVS V2.2 / account enumeration):
 * the response must not tell a caller which of a person's identifiers is registered. The
 * production path is to tell the existing account's owner out of band (e-mail/SMS "someone
 * tried to register with your details") from the notification service.
 */
interface PreparedRegistration {
  idHmac: string;
  passwordHash: string;
  customerType: 'BUSINESS' | 'INDIVIDUAL';
  currency: CurrencyCode;
  kycStatus: KycStatus;
}

const registrationConflict = () =>
  new ConflictError(
    ErrorCode.REGISTRATION_CONFLICT,
    'Registration could not be completed with these details',
  );

/**
 * Customer (borrower) self-registration on an institution's white-label front-end. Creates the
 * CUSTOMER user and the KYC profile in one tenant transaction, signs the customer in, and
 * emits `customer.registered`. The BVN/NIN is never stored: only HMAC-SHA256 under a
 * per-tenant key derived from a secret (deduplication per tenant without a reversible copy)
 * and the last 4 digits.
 *
 * Abuse limits: the per-IP `auth` policy (controller) plus a per-institution cap on
 * registrations per hour (`signup` budget), so one lender's front-end cannot be used to mint
 * customer accounts in bulk. Duplicate national id or email both yield the same generic 409.
 */
@Injectable()
export class RegisterCustomer {
  constructor(
    private readonly resolver: TenantResolver,
    private readonly runner: TransactionRunner,
    private readonly passwords: PasswordService,
    private readonly sessions: TenantSessions,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly limiter: RateLimiterService,
    @Inject(IDENTITY_VERIFIER) private readonly identity: IdentityVerifier,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  async execute(slug: string, dto: RegisterCustomerDto): Promise<CustomerRegistrationDto> {
    if (!isPastCalendarDate(dto.dateOfBirth)) {
      throw new ValidationError('Request validation failed', [
        { field: 'dateOfBirth', message: 'dateOfBirth must be a valid date in the past' },
      ]);
    }
    const currency = assertCurrency(dto.currency);

    const institution = await this.resolver.institutionBySlug(slug);
    if (!institution) throw new NotFoundError('Institution');
    if (institution.status !== 'ACTIVE') {
      throw new ForbiddenError(ErrorCode.INSTITUTION_SUSPENDED, 'This institution is suspended');
    }
    const tenantId = institution.id;
    // Before any expensive work (argon2, KYC provider call).
    await this.limiter.consume('signup', tenantId);

    const idHmac = nationalIdHmac(this.config.BVN_HMAC_KEY, tenantId, dto.nationalId);
    const passwordHash = await this.passwords.hash(dto.password);
    const customerType = dto.customerType ?? 'BUSINESS';
    // Outside the transaction: a provider round trip must not hold a pooled connection.
    const kycStatus = await this.identity.verifyNationalId(dto.nationalId);

    try {
      return await this.persist(tenantId, dto, {
        idHmac,
        passwordHash,
        customerType,
        currency,
        kycStatus,
      });
    } catch (err) {
      // A concurrent registration won the unique constraint: same generic answer.
      if (isUniqueViolation(err)) throw registrationConflict();
      throw err;
    }
  }

  private persist(
    tenantId: string,
    dto: RegisterCustomerDto,
    prepared: PreparedRegistration,
  ): Promise<CustomerRegistrationDto> {
    const { idHmac, passwordHash, customerType, currency, kycStatus } = prepared;
    return this.runner.runForTenant(tenantId, async (tx) => {
      const settings = await tx
        .selectFrom('institutions')
        .select('supported_currencies')
        .where('id', '=', tenantId)
        .executeTakeFirstOrThrow();
      if (!settings.supported_currencies.includes(currency)) {
        throw new BusinessRuleError(
          ErrorCode.UNSUPPORTED_CURRENCY,
          `Currency ${currency} is not offered by this institution`,
        );
      }

      const duplicateId = await tx
        .selectFrom('customers')
        .select('id')
        .where('national_id_hmac', '=', idHmac)
        .executeTakeFirst();
      const duplicateEmail = await tx
        .selectFrom('users')
        .select('id')
        .where((eb) => eb(eb.fn('lower', ['email']), '=', dto.email))
        .executeTakeFirst();
      // Both clashes are still detected, but answered identically.
      if (duplicateId || duplicateEmail) throw registrationConflict();

      const user = await tx
        .insertInto('users')
        .values({
          tenant_id: tenantId,
          email: dto.email,
          full_name: `${dto.firstName.trim()} ${dto.lastName.trim()}`,
          password_hash: passwordHash,
          role: 'CUSTOMER',
        })
        .returning(['id', 'role'])
        .executeTakeFirstOrThrow();

      const row = await tx
        .insertInto('customers')
        .values({
          tenant_id: tenantId,
          user_id: user.id,
          reference: newCustomerReference(),
          customer_type: customerType,
          first_name: dto.firstName.trim(),
          last_name: dto.lastName.trim(),
          business_name: customerType === 'BUSINESS' ? (dto.businessName?.trim() ?? null) : null,
          business_registration_number:
            customerType === 'BUSINESS' ? (dto.businessRegistrationNumber?.trim() ?? null) : null,
          operating_licence_number: dto.operatingLicenceNumber?.trim() ?? null,
          email: dto.email,
          phone: dto.phone,
          date_of_birth: dto.dateOfBirth,
          national_id_hmac: idHmac,
          national_id_last4: dto.nationalId.slice(-4),
          kyc_status: kycStatus,
          employment_status: dto.employmentStatus,
          employer_name: dto.employerName?.trim() ?? null,
          months_in_employment: dto.monthsInEmployment,
          currency,
          monthly_income: BigInt(dto.monthlyIncome),
          monthly_expenses: BigInt(dto.monthlyExpenses),
          existing_monthly_debt: BigInt(dto.existingMonthlyDebt),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const customer = CustomerDto.from(row);

      await this.audit.record(tx, {
        tenantId,
        action: 'customer.registered',
        entityType: 'customer',
        entityId: customer.id,
        after: customer,
      });
      await this.outbox.publish(tx, {
        tenantId,
        type: 'customer.registered',
        aggregateType: 'customer',
        aggregateId: customer.id,
        data: {
          customerId: customer.id,
          reference: customer.reference,
          customerType: customer.customerType,
          kycStatus: customer.kycStatus,
        },
      });

      const tokens = await this.sessions.issue(tx, { id: user.id, tenantId, role: user.role });
      return { customer, tokens };
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}
