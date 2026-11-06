import { randomInt } from 'node:crypto';

/** Unambiguous alphabet (no 0/O, 1/I/L) for references read out over the phone. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/**
 * Human reference such as `APP-7KQ2MX` / `LN-9XH4TB` from a CSPRNG (31^6 ≈ 8.9e8 values);
 * uniqueness per tenant is enforced by the database.
 */
export function newReference(prefix: 'APP' | 'LN'): string {
  let suffix = '';
  for (let i = 0; i < 6; i++) suffix += ALPHABET.charAt(randomInt(ALPHABET.length));
  return `${prefix}-${suffix}`;
}
