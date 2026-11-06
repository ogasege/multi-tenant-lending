import type { AuditWriter } from '../../../common/audit/audit-writer';
import type { TenantUser } from '../../../common/auth/decorators';
import type { TransactionRunner } from '../../../common/database/transaction-runner';
import { AppError } from '../../../common/errors/app-error';
import type { OutboxWriter } from '../../../common/outbox/outbox-writer';
import type { ApplicationsRepository } from '../infrastructure/applications.repository';

import { type CheckoutOrder, CheckoutOrders } from './ports/checkout-orders.port';
import { SubmitApplication } from './submit-application.use-case';

const CUSTOMER_ID = 'cust-alice';
const VENDOR = { name: 'Supplier Ltd', account: '0123456789' };

/** An adapter returning one fixed order (or nothing). */
class FixedOrders extends CheckoutOrders {
  constructor(private readonly order: Omit<CheckoutOrder, 'reference' | 'currency'> | null) {
    super();
  }

  find(reference: string, { currency }: { currency: string }) {
    return Promise.resolve(this.order ? { reference, currency, ...this.order } : undefined);
  }
}

const customerPrincipal = {
  kind: 'USER',
  id: 'user-alice',
  tenantId: 'tenant-1',
  role: 'CUSTOMER',
} as unknown as TenantUser;

function useCase(
  order: Omit<CheckoutOrder, 'reference' | 'currency'> | null,
  repoOverrides: Partial<Record<keyof ApplicationsRepository, unknown>> = {},
) {
  const repo = {
    customerByUserId: () =>
      Promise.resolve({ id: CUSTOMER_ID, currency: 'NGN', kyc_status: 'VERIFIED' }),
    productWithCurrentVersion: () =>
      Promise.resolve({
        product: { id: 'prod-1', status: 'ACTIVE' },
        version: {
          id: 'ver-1',
          currency: 'NGN',
          min_principal: 1n,
          max_principal: 1_000_000_000n,
          min_term: 1,
          max_term: 24,
          disbursement_mode: 'VENDOR',
        },
      }),
    hasLiveApplicationForOrder: () => Promise.resolve(false),
    insert: (_tx: unknown, values: Record<string, unknown>) =>
      Promise.resolve({
        id: 'app-1',
        submitted_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
        decided_by: null,
        decided_at: null,
        decision_notes: null,
        rejection_reason_codes: null,
        approved_principal: null,
        expires_at: null,
        ...values,
      }),
    ...repoOverrides,
  } as unknown as ApplicationsRepository;
  const runner = { run: (fn: (tx: unknown) => unknown) => fn({}) } as unknown as TransactionRunner;
  const audit = { record: () => Promise.resolve() } as unknown as AuditWriter;
  const outbox = { publish: () => Promise.resolve() } as unknown as OutboxWriter;
  return new SubmitApplication(runner, repo, audit, outbox, new FixedOrders(order));
}

const command = (principal = '50000000') => ({
  productId: 'prod-1',
  principal,
  term: 3,
  externalOrderReference: 'ORD-1',
});

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

describe('SubmitApplication — checkout order binding', () => {
  it('refuses a principal above an attested order total (422)', async () => {
    const err = await failure(
      useCase({ vendor: VENDOR, buyerCustomerId: CUSTOMER_ID, total: 49_999_999n }).execute(
        customerPrincipal,
        command(),
      ),
    );
    expect(err).toMatchObject({
      status: 422,
      code: 'ORDER_AMOUNT_EXCEEDED',
      details: { orderTotal: '49999999' },
    });
  });

  it('refuses an order attested to another buyer (422), before revealing its total', async () => {
    const err = await failure(
      useCase({ vendor: VENDOR, buyerCustomerId: 'cust-bob', total: 1n }).execute(
        customerPrincipal,
        command(),
      ),
    );
    expect(err).toMatchObject({ status: 422, code: 'ORDER_NOT_FOR_APPLICANT' });
    expect(err.details).not.toHaveProperty('orderTotal');
  });

  it('skips the buyer and total checks when the adapter cannot attest them', async () => {
    await expect(
      useCase({ vendor: VENDOR }).execute(customerPrincipal, command()),
    ).resolves.toMatchObject({ externalOrderReference: 'ORD-1' });
  });

  it('refuses an order that already backs a live application (409, pre-check)', async () => {
    const err = await failure(
      useCase(
        { vendor: VENDOR },
        { hasLiveApplicationForOrder: () => Promise.resolve(true) },
      ).execute(customerPrincipal, command()),
    );
    expect(err).toMatchObject({ status: 409, code: 'ORDER_ALREADY_FINANCED' });
  });

  it('maps losing the race on loan_applications_order_once to the same 409', async () => {
    const violation = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'loan_applications_order_once',
    });
    const err = await failure(
      useCase({ vendor: VENDOR }, { insert: () => Promise.reject(violation) }).execute(
        customerPrincipal,
        command(),
      ),
    );
    expect(err).toMatchObject({
      status: 409,
      code: 'ORDER_ALREADY_FINANCED',
      details: { externalOrderReference: 'ORD-1' },
    });
  });

  it('leaves other unique violations to the global handler', async () => {
    const violation = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'loan_applications_reference_key',
    });
    await expect(
      useCase({ vendor: VENDOR }, { insert: () => Promise.reject(violation) }).execute(
        customerPrincipal,
        command(),
      ),
    ).rejects.toBe(violation);
  });
});
