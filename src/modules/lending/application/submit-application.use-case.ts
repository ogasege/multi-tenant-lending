import { Injectable } from '@nestjs/common';

import { AuditWriter } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import type { Tx } from '../../../common/database/database.tokens';
import type { PayeeType } from '../../../common/database/schema';
import { TransactionRunner } from '../../../common/database/transaction-runner';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';
import { OutboxWriter } from '../../../common/outbox/outbox-writer';
import {
  type ApplicationRow,
  ApplicationsRepository,
  type CustomerRow,
} from '../infrastructure/applications.repository';
import { newReference } from '../infrastructure/references';

import { type ApplicationView, audienceOf, toApplicationView } from './lending.views';
import { CheckoutOrders } from './ports/checkout-orders.port';

/** The V5 partial unique index: one live application per (tenant, checkout order). */
const ORDER_ONCE_CONSTRAINT = 'loan_applications_order_once';

interface Payee {
  type: PayeeType;
  name: string;
  account: string;
}

export interface SubmitApplicationCommand {
  /** Required when staff apply on a customer's behalf; ignored rules for customers below. */
  customerId?: string;
  productId: string;
  principal: string;
  term: number;
  purpose?: string;
  /** Required for BORROWER-mode products; for VENDOR-mode it comes from the checkout order. */
  payee?: { type?: PayeeType; name: string; account: string };
  /** Required for VENDOR-mode products; refused (422) for BORROWER-mode products. */
  externalOrderReference?: string;
}

/**
 * Submits a loan application against a product's CURRENT version (SPEC §7.1, §7.2).
 *
 * A CUSTOMER applies for themself (a different `customerId` is reported as 404, never as
 * another customer's existence); a CREDIT_OFFICER applies on a customer's behalf and must name
 * the customer. Rules, in order: product exists and is ACTIVE (422 PRODUCT_NOT_ACTIVE);
 * principal and term within the version's limits (422 AMOUNT_/TERM_OUT_OF_PRODUCT_RANGE);
 * customer currency = product currency (422 CURRENCY_MISMATCH); customer KYC VERIFIED
 * (422 KYC_NOT_VERIFIED). Writes the application, audit and `loan_application.submitted` in
 * one transaction.
 *
 * Payee (who receives the disbursement) — never simply whatever the borrower typed:
 *
 * - VENDOR-mode products (checkout financing): `externalOrderReference` is required (400) and
 *   the payee is the order's vendor as resolved by the procurement platform
 *   ({@link CheckoutOrders}); an unknown order is 422 CHECKOUT_ORDER_NOT_FOUND. A payee in the
 *   request is optional and, if present, must be that same VENDOR account (else 422
 *   PAYEE_NOT_ALLOWED); its name is replaced by the platform's. When the platform attests
 *   them, the order's buyer must be the applicant (422 ORDER_NOT_FOR_APPLICANT) and the
 *   principal must not exceed the order total (422 ORDER_AMOUNT_EXCEEDED); the mock adapter
 *   attests neither, real adapters must attest both.
 * - BORROWER-mode products: the payee is required; a CUSTOMER can only name a payee of the
 *   product's disbursement mode (a VENDOR payee is 422 PAYEE_NOT_ALLOWED), while staff may
 *   direct it to a vendor (audited). An `externalOrderReference` is refused (422
 *   ORDER_REFERENCE_NOT_ALLOWED): it would never be resolved through {@link CheckoutOrders},
 *   so accepting it would let anyone reserve another pharmacy's order and block its real
 *   checkout. PRODUCTION PATH: the account is confirmed by a bank name enquiry (NIBSS NIP NE /
 *   the WAEMU switch equivalent) before approval, and the disbursement refused unless the
 *   returned account name matches the KYC-verified customer name; the mock payment gateway
 *   stands in for it today.
 *
 * A checkout order backs at most one live (SUBMITTED, ASSESSED, APPROVED) application per
 * tenant: checked in the transaction and, for concurrent submissions, enforced by the
 * `loan_applications_order_once` unique index; both are 409 ORDER_ALREADY_FINANCED. A
 * rejected, withdrawn or expired application frees the order. The single-use check runs
 * last, only once the order is resolved and every ownership check has passed (not found →
 * wrong buyer → amount → payee → single use), so a refused application never consumes an
 * order and never reveals whether it is already financed.
 *
 * LIMITATION: with the mock adapter (no buyer attestation) any customer of the tenant can
 * still reserve a VENDOR order that another pharmacy placed, in the demo. A real procurement
 * adapter that attests `buyerCustomerId` closes it.
 */
@Injectable()
export class SubmitApplication {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly repo: ApplicationsRepository,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly orders: CheckoutOrders,
  ) {}

  execute(principal: TenantUser, cmd: SubmitApplicationCommand): Promise<ApplicationView> {
    return this.runner.run(async (tx) => {
      const customer = await this.applicant(tx, principal, cmd.customerId);
      if (!customer || (cmd.customerId !== undefined && customer.id !== cmd.customerId)) {
        throw new NotFoundError('Customer', cmd.customerId);
      }

      const found = await this.repo.productWithCurrentVersion(tx, cmd.productId);
      if (!found) throw new NotFoundError('Loan product', cmd.productId);
      const { product, version } = found;
      if (product.status !== 'ACTIVE') {
        throw new BusinessRuleError(ErrorCode.PRODUCT_NOT_ACTIVE, 'This product is archived');
      }

      const principalAmount = BigInt(cmd.principal);
      if (principalAmount < version.min_principal || principalAmount > version.max_principal) {
        throw new BusinessRuleError(
          ErrorCode.AMOUNT_OUT_OF_PRODUCT_RANGE,
          `Principal must be between ${version.min_principal} and ${version.max_principal} ${version.currency} minor units`,
          {
            minPrincipal: version.min_principal.toString(),
            maxPrincipal: version.max_principal.toString(),
          },
        );
      }
      if (cmd.term < version.min_term || cmd.term > version.max_term) {
        throw new BusinessRuleError(
          ErrorCode.TERM_OUT_OF_PRODUCT_RANGE,
          `Term must be between ${version.min_term} and ${version.max_term}`,
          { minTerm: version.min_term, maxTerm: version.max_term },
        );
      }
      if (customer.currency !== version.currency) {
        throw new BusinessRuleError(
          ErrorCode.CURRENCY_MISMATCH,
          `The customer reports in ${customer.currency} but the product lends in ${version.currency}`,
        );
      }
      if (customer.kyc_status !== 'VERIFIED') {
        throw new BusinessRuleError(
          ErrorCode.KYC_NOT_VERIFIED,
          'The customer’s identity has not been verified',
        );
      }

      const { payee, orderReference } = await this.payee(
        tx,
        principal,
        version.disbursement_mode,
        cmd,
        { currency: version.currency, customerId: customer.id, principal: principalAmount },
      );

      const row = await this.insert(tx, {
        tenant_id: principal.tenantId,
        reference: newReference('APP'),
        customer_id: customer.id,
        product_id: product.id,
        product_version_id: version.id,
        currency: version.currency,
        requested_principal: principalAmount,
        term: cmd.term,
        purpose: cmd.purpose?.trim() ?? null,
        payee_type: payee.type,
        payee_name: payee.name,
        payee_account: payee.account,
        external_order_reference: orderReference,
        status: 'SUBMITTED',
        submitted_by: principal.id,
      });
      const view = toApplicationView(row, null);

      await this.audit.record(tx, {
        action: 'loan_application.submitted',
        entityType: 'loan_application',
        entityId: row.id,
        after: view,
      });
      await this.outbox.publish(tx, {
        type: 'loan_application.submitted',
        aggregateType: 'loan_application',
        aggregateId: row.id,
        data: {
          applicationId: row.id,
          reference: row.reference,
          customerId: row.customer_id,
          productId: row.product_id,
          currency: row.currency,
          requestedPrincipal: row.requested_principal.toString(),
          term: row.term,
          externalOrderReference: row.external_order_reference,
        },
      });
      return toApplicationView(row, null, audienceOf(principal));
    });
  }

  /** Inserts the application; losing the single-use race on the order is a 409. */
  private async insert(
    tx: Tx,
    values: Parameters<ApplicationsRepository['insert']>[1],
  ): Promise<ApplicationRow> {
    try {
      return await this.repo.insert(tx, values);
    } catch (err) {
      if (isUniqueViolationOf(err, ORDER_ONCE_CONSTRAINT)) {
        throw orderAlreadyFinanced(values.external_order_reference ?? '');
      }
      throw err;
    }
  }

  /**
   * The disbursement payee and, for checkout financing, the resolved order reference (rules
   * in the class comment). For VENDOR products the checks run in a fixed order — not found →
   * wrong buyer → amount → payee → single use — so the single-use lookup only ever happens
   * for an order the applicant is entitled to.
   */
  private async payee(
    tx: Tx,
    principal: TenantUser,
    mode: PayeeType,
    cmd: SubmitApplicationCommand,
    applicant: { currency: string; customerId: string; principal: bigint },
  ): Promise<{ payee: Payee; orderReference: string | null }> {
    const { currency } = applicant;
    if (mode === 'VENDOR') {
      const reference = cmd.externalOrderReference;
      if (reference === undefined) {
        throw new ValidationError('Request validation failed', [
          {
            field: 'externalOrderReference',
            message: 'externalOrderReference is required for checkout (VENDOR) financing',
          },
        ]);
      }
      const order = await this.orders.find(reference, { tenantId: principal.tenantId, currency });
      if (!order) {
        throw new BusinessRuleError(
          ErrorCode.CHECKOUT_ORDER_NOT_FOUND,
          'The checkout order is unknown to the procurement platform',
          { externalOrderReference: reference },
        );
      }
      // Buyer first: someone else's order reveals nothing more about it (not even its total).
      if (order.buyerCustomerId !== undefined && order.buyerCustomerId !== applicant.customerId) {
        throw new BusinessRuleError(
          ErrorCode.ORDER_NOT_FOR_APPLICANT,
          'The checkout order was not placed by the applicant',
          { externalOrderReference: reference },
        );
      }
      if (order.total !== undefined && applicant.principal > order.total) {
        throw new BusinessRuleError(
          ErrorCode.ORDER_AMOUNT_EXCEEDED,
          `The principal exceeds the checkout order total of ${order.total} ${currency} minor units`,
          { externalOrderReference: reference, orderTotal: order.total.toString() },
        );
      }
      if (
        cmd.payee &&
        ((cmd.payee.type ?? 'VENDOR') !== 'VENDOR' || cmd.payee.account !== order.vendor.account)
      ) {
        throw new BusinessRuleError(
          ErrorCode.PAYEE_NOT_ALLOWED,
          'Checkout financing is paid to the order’s vendor only',
        );
      }
      // Single use last: only an order the applicant may finance is looked up (or reserved).
      if (await this.repo.hasLiveApplicationForOrder(tx, reference)) {
        throw orderAlreadyFinanced(reference);
      }
      return {
        payee: { type: 'VENDOR', name: order.vendor.name, account: order.vendor.account },
        orderReference: reference,
      };
    }

    if (cmd.externalOrderReference !== undefined) {
      throw new BusinessRuleError(
        ErrorCode.ORDER_REFERENCE_NOT_ALLOWED,
        'Order references apply only to checkout (supplier-paid) products',
        { disbursementMode: mode },
      );
    }
    if (!cmd.payee) {
      throw new ValidationError('Request validation failed', [
        { field: 'payee', message: 'payee is required for this product' },
      ]);
    }
    const type = cmd.payee.type ?? mode;
    if (principal.role === 'CUSTOMER' && type !== mode) {
      throw new BusinessRuleError(
        ErrorCode.PAYEE_NOT_ALLOWED,
        `This product disburses to a ${mode.toLowerCase()} payee only`,
        { disbursementMode: mode },
      );
    }
    return {
      payee: { type, name: cmd.payee.name.trim(), account: cmd.payee.account },
      orderReference: null,
    };
  }

  /** A customer applies for themself; staff must name the customer they apply for. */
  private applicant(
    tx: Tx,
    principal: TenantUser,
    customerId: string | undefined,
  ): Promise<CustomerRow | undefined> {
    if (principal.role === 'CUSTOMER') return this.repo.customerByUserId(tx, principal.id);
    if (!customerId) {
      throw new ValidationError('Request validation failed', [
        { field: 'customerId', message: 'customerId is required when applying for a customer' },
      ]);
    }
    return this.repo.customerById(tx, customerId);
  }
}

function orderAlreadyFinanced(externalOrderReference: string): ConflictError {
  return new ConflictError(
    ErrorCode.ORDER_ALREADY_FINANCED,
    'The checkout order already backs a live loan application',
    { externalOrderReference },
  );
}

/** A PostgreSQL unique violation (23505) raised by the named constraint / unique index. */
function isUniqueViolationOf(err: unknown, constraint: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    err.code === '23505' &&
    'constraint' in err &&
    err.constraint === constraint
  );
}
