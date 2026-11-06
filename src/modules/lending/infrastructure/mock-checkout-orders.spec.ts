import { MockCheckoutOrders } from './mock-checkout-orders';

describe('MockCheckoutOrders', () => {
  const orders = new MockCheckoutOrders();
  const ctx = (currency: string) => ({ tenantId: 't-1', currency });

  it('resolves demo orders to the deterministic supplier of their currency', async () => {
    await expect(orders.find('ORD-2026-000123', ctx('NGN'))).resolves.toEqual({
      reference: 'ORD-2026-000123',
      currency: 'NGN',
      vendor: { name: 'Medisource Distributors Ltd', account: '0123456789' },
    });
    await expect(orders.find('ORD-1', ctx('XOF'))).resolves.toMatchObject({
      vendor: { name: 'Sahel Pharma Distribution SARL', account: 'SN012010100000123456' },
    });
  });

  it('rejects unknown references', async () => {
    for (const ref of ['ORDER-1', 'ord-1', 'ORD-', 'ORD-ABC', 'X-ORD-1', 'ORD-1:evil']) {
      await expect(orders.find(ref, ctx('NGN'))).resolves.toBeUndefined();
    }
  });
});
