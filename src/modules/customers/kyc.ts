import { randomInt } from 'node:crypto';

export type KycStatus = 'PENDING' | 'VERIFIED';

/**
 * Port to the identity (BVN/NIN) verification provider. Selected by `KYC_PROVIDER`; only
 * `mock` exists today and the env schema refuses it in production.
 *
 * Integration point for a real provider (NIBSS BVN, NIMC NIN, Smile ID…): implement this
 * interface in an infrastructure adapter (outbound HTTPS with mTLS/API key from Secrets
 * Manager, timeouts, no PII in logs), add its name to the `KYC_PROVIDER` enum and bind it in
 * `CustomersModule`. Providers that verify asynchronously return PENDING here and settle the
 * status later through a signed callback.
 */
export interface IdentityVerifier {
  verifyNationalId(nationalId: string): Promise<KycStatus>;
}

export const IDENTITY_VERIFIER = Symbol('IDENTITY_VERIFIER');

/**
 * MOCK identity verification, standing in for a BVN/NIN provider (NIBSS, NIMC, Smile ID…).
 * Deterministic for demos and tests: an 11-digit id is VERIFIED unless it starts with "000",
 * which simulates a provider that could not match the record (left PENDING for manual review).
 */
export function mockVerifyNationalId(nationalId: string): KycStatus {
  return /^\d{11}$/.test(nationalId) && !nationalId.startsWith('000') ? 'VERIFIED' : 'PENDING';
}

/** `KYC_PROVIDER=mock`: deterministic stand-in for development and tests only. */
export class MockIdentityVerifier implements IdentityVerifier {
  verifyNationalId(nationalId: string): Promise<KycStatus> {
    return Promise.resolve(mockVerifyNationalId(nationalId));
  }
}

/** Unambiguous alphabet (no 0/O, 1/I/L) for references read out over the phone. */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Customer reference, e.g. `CUS-7KQ2MX`, from a CSPRNG. Unique per tenant (DB constraint). */
export function newCustomerReference(): string {
  let suffix = '';
  for (let i = 0; i < 6; i++)
    suffix += REFERENCE_ALPHABET.charAt(randomInt(REFERENCE_ALPHABET.length));
  return `CUS-${suffix}`;
}

/** True when `value` is a real calendar date (rejects e.g. 2023-02-30) strictly before today. */
export function isPastCalendarDate(value: string, today = new Date()): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value < today.toISOString().slice(0, 10)
  );
}
