import type { FactoryProvider } from '@nestjs/common';

import type { Env } from '../../../config/env.schema';
import { MockCreditBureau } from '../domain';

import { MockCheckoutOrders } from './mock-checkout-orders';
import { MockPaymentGateway } from './mock-payment-gateway';
import { checkoutOrdersProvider, creditBureauProvider, paymentGatewayProvider } from './providers';

const config = {
  PAYMENT_PROVIDER: 'mock',
  CREDIT_BUREAU_PROVIDER: 'mock',
  CHECKOUT_ORDERS_PROVIDER: 'mock',
  BVN_HMAC_KEY: 'b'.repeat(64),
} as Env;

const build = (provider: unknown): unknown =>
  (provider as FactoryProvider).useFactory(config) as unknown;

describe('lending adapter selection', () => {
  it('binds each port to the adapter its *_PROVIDER names', () => {
    expect(build(paymentGatewayProvider)).toBeInstanceOf(MockPaymentGateway);
    expect(build(creditBureauProvider)).toBeInstanceOf(MockCreditBureau);
    expect(build(checkoutOrdersProvider)).toBeInstanceOf(MockCheckoutOrders);
  });
});
