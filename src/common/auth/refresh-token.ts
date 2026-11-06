import { randomToken, sha256Hex } from '../crypto/crypto';

export interface IssuedRefreshToken {
  /** Returned to the client once; never stored. */
  token: string;
  /** SHA-256 of the token: the only form persisted (a DB leak yields no usable tokens). */
  hash: string;
  expiresAt: Date;
}

/** 256-bit opaque refresh token (SPEC §5), rotated on every use. */
export function newRefreshToken(ttlDays: number, now = new Date()): IssuedRefreshToken {
  const token = randomToken(32);
  return {
    token,
    hash: hashRefreshToken(token),
    expiresAt: new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000),
  };
}

export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}
