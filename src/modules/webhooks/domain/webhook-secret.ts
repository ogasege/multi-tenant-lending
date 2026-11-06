import { randomBytes } from 'node:crypto';

import { decrypt, encrypt } from '../../../common/crypto/crypto';

/** Standard Webhooks secret prefix; the remainder is the base64 of the raw HMAC key. */
export const SECRET_PREFIX = 'whsec_';
/** 256-bit HMAC-SHA256 key (Standard Webhooks allows 24–64 bytes). */
const SECRET_BYTES = 32;

/** A fresh signing secret in Standard Webhooks format: `whsec_<base64(32 random bytes)>`. */
export function generateSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64')}`;
}

/**
 * Additional authenticated data binding a secret's ciphertext to its row: a ciphertext copied
 * into another endpoint or tenant fails to decrypt.
 */
export function secretAad(tenantId: string, endpointId: string): string {
  return `${tenantId}|${endpointId}`;
}

/** AES-256-GCM encryption of a signing secret for `webhook_endpoints.secret_ciphertext`. */
export function sealSecret(
  secret: string,
  keyBase64: string,
  tenantId: string,
  endpointId: string,
): string {
  return encrypt(secret, keyBase64, secretAad(tenantId, endpointId));
}

export function openSecret(
  ciphertext: string,
  keyBase64: string,
  tenantId: string,
  endpointId: string,
): string {
  return decrypt(ciphertext, keyBase64, secretAad(tenantId, endpointId));
}
