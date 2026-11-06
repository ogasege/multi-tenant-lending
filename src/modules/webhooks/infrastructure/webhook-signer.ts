import { Webhook } from 'standardwebhooks';

export interface StandardWebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/**
 * Standard Webhooks signing via the reference `standardwebhooks` library:
 * `webhook-signature: v1,<base64 HMAC-SHA256(secret, "${id}.${timestamp}.${body}")>`.
 * Receivers verify with `new Webhook(secret).verify(body, headers)` (which also rejects
 * timestamps more than 5 minutes off) and deduplicate on `webhook-id`.
 */
export function signWebhook(
  secret: string,
  messageId: string,
  timestamp: Date,
  payload: string,
): StandardWebhookHeaders {
  const signature = new Webhook(secret).sign(messageId, timestamp, payload);
  return {
    'webhook-id': messageId,
    'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'webhook-signature': signature,
  };
}
