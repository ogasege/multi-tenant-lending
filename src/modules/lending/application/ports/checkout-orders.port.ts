/** A checkout order as the procurement platform knows it. */
export interface CheckoutOrder {
  reference: string;
  currency: string;
  /** The vendor the order is payable to: the ONLY payee a VENDOR loan may disburse to. */
  vendor: { name: string; account: string };
  /**
   * The customer (our `customers.id`, in the requesting tenant) who placed the order.
   * `undefined` means this adapter cannot attest the buyer; a real procurement-platform
   * adapter MUST return it, so an order cannot be financed for someone else's purchase.
   */
  buyerCustomerId?: string;
  /**
   * The order total in minor units of `currency`. `undefined` means this adapter cannot
   * attest the total; a real procurement-platform adapter MUST return it, so the financed
   * principal is bounded by what the order actually costs.
   */
  total?: bigint;
}

/**
 * Procurement-platform port (hexagonal boundary): resolves a checkout order reference to the
 * vendor it is payable to, its buyer and its total. VENDOR-mode (checkout financing) loans
 * take their payee from here, never from the request, so a borrower cannot redirect a vendor
 * disbursement to an account of their choosing (SPEC §7.1); the buyer and total, when
 * attested, bind the order to the applicant and bound the principal.
 *
 * Production adapter: an authenticated call to the procurement platform's order API (mTLS
 * or a signed service token), scoped to the institution, returning the order's vendor and
 * its verified settlement account, the buyer (mapped to our customer id) and the order
 * total. It MUST populate `buyerCustomerId` and `total`; leaving them `undefined` disables
 * the applicant and amount checks. Adapter selected by `CHECKOUT_ORDERS_PROVIDER`; only
 * `mock` exists today.
 */
export abstract class CheckoutOrders {
  /** The order, or `undefined` when the platform does not know the reference. */
  abstract find(
    reference: string,
    context: { tenantId: string; currency: string },
  ): Promise<CheckoutOrder | undefined>;
}
