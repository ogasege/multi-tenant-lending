import { randomBytes } from 'node:crypto';

import { Webhook, WebhookVerificationError } from 'standardwebhooks';

import { webhookPayload } from '../domain/domain-event-message';
import { generateSigningSecret, openSecret, sealSecret } from '../domain/webhook-secret';

import { signWebhook } from './webhook-signer';

const event = {
  id: '8f14e45f-ceea-4e7a-9f6b-1b2c3d4e5f60',
  tenantId: '0b7d8f1e-1111-4222-8333-444455556666',
  type: 'loan.disbursed',
  aggregateType: 'loan',
  aggregateId: 'loan-1',
  occurredAt: '2026-11-06T10:00:00.000Z',
  data: { loanId: 'loan-1', amount: '5000000', currency: 'NGN' },
};

describe('Standard Webhooks signing', () => {
  it('issues whsec_ secrets with a 256-bit key', () => {
    const secret = generateSigningSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(secret.slice(6), 'base64')).toHaveLength(32);
    expect(generateSigningSecret()).not.toBe(secret);
  });

  it('round-trips through the reference verifier', () => {
    const secret = generateSigningSecret();
    const body = webhookPayload(event);
    const headers = signWebhook(secret, event.id, new Date(), body);

    expect(headers['webhook-id']).toBe(event.id);
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    const verified = new Webhook(secret).verify(body, { ...headers });
    expect(verified).toEqual({
      id: event.id,
      type: event.type,
      timestamp: event.occurredAt,
      data: event.data,
    });
  });

  it('fails verification for a tampered body, another secret or a stale timestamp', () => {
    const secret = generateSigningSecret();
    const body = webhookPayload(event);
    const headers = { ...signWebhook(secret, event.id, new Date(), body) };
    expect(() => new Webhook(secret).verify(body.replace('5000000', '9000000'), headers)).toThrow(
      WebhookVerificationError,
    );
    expect(() => new Webhook(generateSigningSecret()).verify(body, headers)).toThrow(
      WebhookVerificationError,
    );
    const old = { ...signWebhook(secret, event.id, new Date(Date.now() - 10 * 60_000), body) };
    expect(() => new Webhook(secret).verify(body, old)).toThrow(WebhookVerificationError);
  });

  it('serialises the body as canonical JSON (stable key order)', () => {
    const a = webhookPayload({ ...event, data: { b: 1, a: 2 } });
    const b = webhookPayload({ ...event, data: { a: 2, b: 1 } });
    expect(a).toBe(b);
    expect(a.indexOf('"data"')).toBeLessThan(a.indexOf('"id"'));
  });

  it('binds the encrypted secret to its tenant and endpoint (AAD)', () => {
    const key = randomBytes(32).toString('base64');
    const secret = generateSigningSecret();
    const sealed = sealSecret(secret, key, 'tenant-a', 'endpoint-1');
    expect(sealed).not.toContain(secret.slice(6, 20));
    expect(openSecret(sealed, key, 'tenant-a', 'endpoint-1')).toBe(secret);
    expect(() => openSecret(sealed, key, 'tenant-b', 'endpoint-1')).toThrow();
    expect(() => openSecret(sealed, key, 'tenant-a', 'endpoint-2')).toThrow();
  });
});
