/** A checkout order as the procurement platform knows it. */
export interface CheckoutOrder {
  reference: string;
  currency: string;
  /** The vendor the order is payable to: the ONLY payee a VENDOR loan may disburse to. */
  vendor: { name: string; account: string };
}

/**
 * Procurement-platform port (hexagonal boundary): resolves a checkout order reference to the
 * vendor it is payable to. VENDOR-mode (checkout financing) loans take their payee from here,
 * never from the request, so a borrower cannot redirect a vendor disbursement to an account
 * of their choosing (SPEC §7.1).
 *
 * Production adapter: an authenticated call to the procurement platform's order API (mTLS
 * or a signed service token), returning the order's vendor and its verified settlement
 * account, scoped to the institution; it should also bound the financed amount by the order
 * total. Adapter selected by `CHECKOUT_ORDERS_PROVIDER`; only `mock` exists today.
 */
export abstract class CheckoutOrders {
  /** The order, or `undefined` when the platform does not know the reference. */
  abstract find(
    reference: string,
    context: { tenantId: string; currency: string },
  ): Promise<CheckoutOrder | undefined>;
}
