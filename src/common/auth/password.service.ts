import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * OWASP Password Storage Cheat Sheet minimum for argon2id: m=19 MiB, t=2, p=1 (SPEC §5).
 * `needsRehash` lets a future parameter bump upgrade hashes transparently at login.
 */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * argon2id hash of a random, discarded secret, computed with {@link ARGON2_OPTIONS}. Verifying
 * against it when the account does not exist costs exactly as much as a real verification, so
 * response timing does not reveal which emails are registered. It can never match.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$i/2/DttTxs+qN5Nz0Fy8vQ$8OmYvZQwkUM9bqcUvAP2OXWy91G1hgUJo5icFxM6H6g';

/** Password hashing for platform admins and tenant users. Stateless; safe to provide anywhere. */
@Injectable()
export class PasswordService {
  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * Constant-work verification. Pass `null` when the account was not found: the dummy hash is
   * verified instead and the result is always `false`. Malformed stored hashes count as a
   * mismatch rather than an error.
   */
  async verify(storedHash: string | null, password: string): Promise<boolean> {
    try {
      const ok = await argon2.verify(storedHash ?? DUMMY_PASSWORD_HASH, password);
      return storedHash !== null && ok;
    } catch {
      return false;
    }
  }
}
