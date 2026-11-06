import { Injectable } from '@nestjs/common';

import { type CheckoutOrder, CheckoutOrders } from '../application/ports/checkout-orders.port';

/** Demo order references, e.g. `ORD-2026-000123` (what the demo checkout hands over). */
const DEMO_ORDER = /^ORD-[0-9][0-9-]{0,40}$/;

/** The demo suppliers of the white-label checkout, per currency (XOF: Senegal / WAEMU). */
const DEMO_VENDORS: Readonly<Record<string, CheckoutOrder['vendor']>> = {
  XOF: { name: 'Sahel Pharma Distribution SARL', account: 'SN012010100000123456' },
};
const DEFAULT_VENDOR: CheckoutOrder['vendor'] = {
  name: 'Medisource Distributors Ltd',
  account: '0123456789',
};

/**
 * `CHECKOUT_ORDERS_PROVIDER=mock`: deterministic stand-in for the procurement platform.
 * Every demo reference (`ORD-` followed by digits and dashes) is an order payable to the
 * demo supplier of its currency; any other reference is unknown. Development and tests only
 * (refused in production).
 */
@Injectable()
export class MockCheckoutOrders extends CheckoutOrders {
  find(
    reference: string,
    { currency }: { tenantId: string; currency: string },
  ): Promise<CheckoutOrder | undefined> {
    if (!DEMO_ORDER.test(reference)) return Promise.resolve(undefined);
    return Promise.resolve({
      reference,
      currency,
      vendor: DEMO_VENDORS[currency] ?? DEFAULT_VENDOR,
    });
  }
}
