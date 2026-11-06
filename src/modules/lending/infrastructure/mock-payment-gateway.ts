import { Injectable } from '@nestjs/common';

import { sha256Hex } from '../../../common/crypto/crypto';
import {
  PaymentGateway,
  PaymentProviderError,
  type TransferRequest,
  type TransferResult,
} from '../application/ports/payment-gateway.port';

/**
 * Deterministic stand-in for a transfer provider.
 *
 * - The provider reference is `MOCK-` + the first 24 hex chars of SHA-256(idempotency key),
 *   so a retried disbursement of the same loan always yields the same reference (and the
 *   unique `(tenant_id, provider_reference)` constraint catches any double payout).
 * - A payee account starting with `000` simulates a provider rejection (closed account).
 *
 * It answers synchronously, inside the disbursement's database transaction. A real provider
 * must NOT be called that way: production would record the loan as `DISBURSING` (pending),
 * commit, call the provider with the loan id as its idempotency key, and confirm the
 * disbursement (schedule + ledger) from the provider's signed webhook — a two-phase
 * pending → confirmed flow that never holds a DB transaction open across a network call.
 */
@Injectable()
export class MockPaymentGateway extends PaymentGateway {
  transfer(request: TransferRequest): Promise<TransferResult> {
    if (request.payee.account.startsWith('000')) {
      return Promise.reject(new PaymentProviderError('payee account rejected by the bank'));
    }
    return Promise.resolve({
      providerReference: `MOCK-${sha256Hex(request.idempotencyKey).slice(0, 24).toUpperCase()}`,
    });
  }
}
