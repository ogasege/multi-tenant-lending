import { randomUUID } from 'node:crypto';

import {
  type CheckoutOrder,
  CheckoutOrders,
} from '@/modules/lending/application/ports/checkout-orders.port';

/** The vendor every strict-fake order is payable to. */
export const STRICT_FAKE_VENDOR: CheckoutOrder['vendor'] = {
  name: 'Strict Fake Supplier Ltd',
  account: '0987654321',
};

/**
 * A procurement-platform adapter that attests everything a real one must: the vendor, the
 * buyer and the total. Orders are registered by the test (`place`); any other reference is
 * unknown. Override the `CheckoutOrders` provider with it to exercise the applicant and
 * amount checks the mock adapter cannot.
 */
export class StrictFakeCheckoutOrders extends CheckoutOrders {
  private readonly orders = new Map<string, Omit<CheckoutOrder, 'reference' | 'currency'>>();

  /** Registers an order placed by `buyerCustomerId` for `total` minor units; its reference. */
  place(buyerCustomerId: string, total: bigint): string {
    const reference = `SO-${randomUUID()}`;
    this.orders.set(reference, { vendor: STRICT_FAKE_VENDOR, buyerCustomerId, total });
    return reference;
  }

  find(
    reference: string,
    { currency }: { tenantId: string; currency: string },
  ): Promise<CheckoutOrder | undefined> {
    const order = this.orders.get(reference);
    return Promise.resolve(order && { reference, currency, ...order });
  }
}
