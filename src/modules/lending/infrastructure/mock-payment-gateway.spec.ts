import { PaymentProviderError } from '../application/ports/payment-gateway.port';

import { MockPaymentGateway } from './mock-payment-gateway';

describe('MockPaymentGateway', () => {
  const gateway = new MockPaymentGateway();
  const request = (account: string) => ({
    idempotencyKey: 'loan-1',
    amount: 98_000_000n,
    currency: 'NGN',
    payee: { type: 'VENDOR' as const, name: 'Emzor', account },
    narration: 'Loan LN-1',
  });

  it('returns a deterministic provider reference per idempotency key', async () => {
    const a = await gateway.transfer(request('0123456789'));
    const b = await gateway.transfer(request('9876543210'));
    expect(a.providerReference).toMatch(/^MOCK-[0-9A-F]{24}$/);
    expect(b).toEqual(a);
  });

  it('rejects payee accounts starting with 000', async () => {
    await expect(gateway.transfer(request('0001234567'))).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
  });
});
