import type { PayeeType } from '../../../../common/database/schema';

export interface TransferRequest {
  /** Stable per disbursement (the loan id): a provider dedupes retries on it. */
  idempotencyKey: string;
  amount: bigint;
  currency: string;
  payee: { type: PayeeType; name: string; account: string };
  narration: string;
}

export interface TransferResult {
  /** Provider's transfer id; unique per tenant (`loans.provider_reference`). */
  providerReference: string;
}

/** The provider rejected or could not execute the transfer (no money moved). */
export class PaymentProviderError extends Error {
  constructor(readonly reason: string) {
    super(`Payment provider rejected the transfer: ${reason}`);
    this.name = 'PaymentProviderError';
  }
}

/**
 * Outbound payments port (hexagonal boundary). Adapters: `MockPaymentGateway` for demo/test;
 * NIBSS NIP / Paystack / Flutterwave transfers (NG) or a GIM-UEMOA switch (WAEMU) in production.
 */
export abstract class PaymentGateway {
  abstract transfer(request: TransferRequest): Promise<TransferResult>;
}
