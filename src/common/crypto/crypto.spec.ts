import { randomBytes } from 'node:crypto';

import {
  canonicalJson,
  decrypt,
  encrypt,
  hmacSha256Hex,
  nationalIdHmac,
  safeEqual,
} from './crypto';

describe('crypto utilities', () => {
  it('derives a separate national-id HMAC key per tenant (HKDF)', () => {
    const master = 'm'.repeat(64);
    const a = nationalIdHmac(master, 'tenant-a', '22212345678');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(nationalIdHmac(master, 'tenant-a', '22212345678')).toBe(a);
    expect(nationalIdHmac(master, 'tenant-b', '22212345678')).not.toBe(a);
    // Never the raw master-key HMAC.
    expect(a).not.toBe(hmacSha256Hex(master, '22212345678'));
  });

  it('produces identical canonical JSON regardless of key order, with bigints as strings', () => {
    expect(canonicalJson({ b: 1n, a: { d: 2, c: [3n] } })).toBe(
      canonicalJson({ a: { c: [3n], d: 2 }, b: 1n }),
    );
    expect(canonicalJson({ amount: 10n })).toBe('{"amount":"10"}');
  });

  it('round-trips AES-256-GCM and uses a fresh IV every time', () => {
    const key = randomBytes(32).toString('base64');
    const a = encrypt('whsec_secret', key);
    const b = encrypt('whsec_secret', key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe('whsec_secret');
  });

  it('rejects tampered ciphertext (authenticated encryption)', () => {
    const key = randomBytes(32).toString('base64');
    const raw = Buffer.from(encrypt('secret', key), 'base64');
    raw[raw.length - 1]! ^= 0xff;
    expect(() => decrypt(raw.toString('base64'), key)).toThrow();
  });

  it('binds ciphertext to its context (AAD) and rejects truncated payloads', () => {
    const key = randomBytes(32).toString('base64');
    const sealed = encrypt('whsec', key, 'tenant-a|endpoint-1');
    expect(decrypt(sealed, key, 'tenant-a|endpoint-1')).toBe('whsec');
    expect(() => decrypt(sealed, key, 'tenant-b|endpoint-1')).toThrow();
    expect(() => decrypt(Buffer.alloc(10).toString('base64'), key)).toThrow(/too short/);
  });

  it('compares secrets in constant time and handles length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
