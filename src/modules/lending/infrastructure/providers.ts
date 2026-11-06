import type { Provider } from '@nestjs/common';

import { APP_CONFIG } from '../../../config/config.module';
import type { Env } from '../../../config/env.schema';
import { CheckoutOrders } from '../application/ports/checkout-orders.port';
import { PaymentGateway } from '../application/ports/payment-gateway.port';
import { type CreditBureauPort, MockCreditBureau } from '../domain';

import { MockCheckoutOrders } from './mock-checkout-orders';
import { MockPaymentGateway } from './mock-payment-gateway';

/** DI token of the credit bureau port. */
export const CREDIT_BUREAU = Symbol('CREDIT_BUREAU');

/**
 * One factory per provider value (exhaustive: a new provider must be bound here). The mocks
 * are refused in production by `parseEnv` (API role), so a production API cannot boot with
 * them; a real adapter adds its name to the env enum and its factory below.
 */
const PAYMENT_GATEWAYS: Readonly<Record<Env['PAYMENT_PROVIDER'], (config: Env) => PaymentGateway>> =
  { mock: () => new MockPaymentGateway() };

/**
 * Mock bureau keyed with `BVN_HMAC_KEY`: the score is a deterministic function of the
 * customer's national-id HMAC, so the same applicant always scores the same.
 */
const CREDIT_BUREAUS: Readonly<
  Record<Env['CREDIT_BUREAU_PROVIDER'], (config: Env) => CreditBureauPort>
> = { mock: (config) => new MockCreditBureau(config.BVN_HMAC_KEY) };

const CHECKOUT_ORDER_SOURCES: Readonly<
  Record<Env['CHECKOUT_ORDERS_PROVIDER'], (config: Env) => CheckoutOrders>
> = { mock: () => new MockCheckoutOrders() };

export const paymentGatewayProvider: Provider<PaymentGateway> = {
  provide: PaymentGateway,
  inject: [APP_CONFIG],
  useFactory: (config: Env) => PAYMENT_GATEWAYS[config.PAYMENT_PROVIDER](config),
};

export const creditBureauProvider: Provider<CreditBureauPort> = {
  provide: CREDIT_BUREAU,
  inject: [APP_CONFIG],
  useFactory: (config: Env) => CREDIT_BUREAUS[config.CREDIT_BUREAU_PROVIDER](config),
};

export const checkoutOrdersProvider: Provider<CheckoutOrders> = {
  provide: CheckoutOrders,
  inject: [APP_CONFIG],
  useFactory: (config: Env) => CHECKOUT_ORDER_SOURCES[config.CHECKOUT_ORDERS_PROVIDER](config),
};
