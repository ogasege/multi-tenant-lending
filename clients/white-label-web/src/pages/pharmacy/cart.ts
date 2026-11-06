/**
 * The supplier cart being financed. In production the supplier's checkout hands over an order
 * reference; the lender resolves the order (and the vendor to pay) from its procurement
 * platform, so the client never names a payee account for checkout financing. For the demo
 * the cart is a fixture per currency whose total equals the amount the seeded demo
 * applicants were scored for (500 000 NGN, 1 000 000 XOF).
 */
import { majorToMinor } from '../../money/format';

export interface CartLine {
  name: string;
  quantity: number;
  /** Line total, minor units. */
  amount: string;
}

export interface Cart {
  /** `ORD-` + digits/dashes: the format the checkout-orders port accepts. */
  orderReference: string;
  /** Display only; the API pays the vendor of the order. */
  supplierName: string;
  lines: CartLine[];
  total: string;
}

const ORDER_REFERENCE = /^ORD-[0-9][0-9-]{0,40}$/;

/** A fresh order reference per cart, e.g. `ORD-20261107-1762473600123`. */
export function newOrderReference(now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `ORD-${day}-${now.getTime()}`;
}

const LINES: Record<'en' | 'fr', [string, number, number][]> = {
  en: [
    ['Artemether/Lumefantrine 20/120 mg · 24 tabs', 16, 208_000],
    ['Amoxicillin 500 mg caps · 100', 24, 164_000],
    ['ORS sachets, carton of 100', 10, 128_000],
  ],
  fr: [
    ['Artéméther/Luméfantrine 20/120 mg · 24 cp', 16, 208_000],
    ['Amoxicilline 500 mg gél. · 100', 24, 164_000],
    ['Sachets SRO, carton de 100', 10, 128_000],
  ],
};

/** XOF prices are about twice the NGN figures in whole units (cart 1 000 000 F CFA). */
const UNIT_FACTOR: Record<string, number> = { XOF: 2 };

export function demoCart(
  currency: string,
  locale: string,
  params: URLSearchParams,
  orderReference: string,
): Cart {
  const fr = locale.startsWith('fr');
  const factor = UNIT_FACTOR[currency] ?? 1;
  const lines = LINES[fr ? 'fr' : 'en'].map(([name, quantity, units]) => ({
    name,
    quantity,
    amount: majorToMinor(units * factor, currency),
  }));
  const total = lines.reduce((sum, l) => sum + BigInt(l.amount), 0n).toString();
  const fromUrl = params.get('order');
  return {
    orderReference: fromUrl && ORDER_REFERENCE.test(fromUrl) ? fromUrl : orderReference,
    supplierName:
      currency === 'XOF' ? 'Sahel Pharma Distribution SARL' : 'Medisource Distributors Ltd',
    lines,
    total,
  };
}
