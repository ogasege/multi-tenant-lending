import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import canonicalize from 'canonicalize';

/**
 * Canonical JSON per RFC 8785 (JSON Canonicalization Scheme) via the `canonicalize` reference
 * implementation: sorted keys, normalised numbers and strings, so the same value always yields
 * the same bytes — in any language. Used for the audit hash chain, idempotency fingerprints and
 * webhook payloads. JSON has no bigint, so amounts are converted to decimal strings first.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(toJsonSafe(value)) ?? 'null';
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: string | Buffer, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/**
 * Domain-separation label of the national-id key derivation. The `v1` is the KEY VERSION:
 * see {@link nationalIdHmac} for rotation.
 */
export const NATIONAL_ID_KDF_SALT = 'tenmg/national-id-hmac/v1';

/**
 * Per-tenant key for national-id (BVN/NIN) HMACs: HKDF-SHA256 (RFC 5869) of `BVN_HMAC_KEY`,
 * with the tenant id as `info`. Each lender's HMACs are therefore unlinkable: equal digests
 * across two tenants' rows (or a dump of one tenant) reveal nothing about the other tenant,
 * and a compromised derived key only covers one tenant.
 */
export function nationalIdKey(masterKey: string, tenantId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, NATIONAL_ID_KDF_SALT, tenantId, 32));
}

/**
 * HMAC-SHA256 of a national id under the tenant's derived key (deduplication without a
 * reversible copy).
 *
 * Key versioning: the master key and `NATIONAL_ID_KDF_SALT` form key version v1. Because
 * the plaintext is never stored, digests cannot be re-computed in bulk; rotation therefore
 * means (1) adding the new master key as a second secret with salt `…/v2`, (2) storing the
 * version next to each digest (a `national_id_hmac_version` column — a DB migration) and
 * writing new rows with v2, (3) checking duplicates against BOTH versions until every v1
 * row has been re-keyed when its owner next presents the id (re-KYC), then (4) retiring v1.
 */
export function nationalIdHmac(masterKey: string, tenantId: string, nationalId: string): string {
  return hmacSha256Hex(nationalIdKey(masterKey, tenantId), nationalId);
}

/** Constant-time comparison of two strings (avoids timing side channels on secrets). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** URL-safe random token with 256 bits of entropy (refresh tokens, webhook secrets). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * AES-256-GCM authenticated encryption for secrets at rest (e.g. webhook signing secrets).
 * Output: base64(iv || authTag || ciphertext). A fresh random IV per message is mandatory
 * for GCM security. `aad` (e.g. "tenantId|endpointId") binds the ciphertext to its row, so a
 * value copied into another row fails to decrypt.
 */
export function encrypt(plaintext: string, keyBase64: string, aad = ''): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decrypt(payload: string, keyBase64: string, aad = ''): string {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < GCM_IV_BYTES + GCM_TAG_BYTES) throw new Error('Ciphertext too short');
  const iv = raw.subarray(0, GCM_IV_BYTES);
  const tag = raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  // Pinning the tag length rejects truncated tags (short-tag forgery).
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv, {
    authTagLength: GCM_TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
