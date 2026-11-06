export const WEBHOOK_ENDPOINT_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type WebhookEndpointStatus = (typeof WEBHOOK_ENDPOINT_STATUSES)[number];

/** Dotted lower-case event names, e.g. `loan.disbursed`, `institution.status_changed`. */
export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
export const MAX_EVENT_TYPES = 50;
/** Resource limit per tenant (OWASP API4): each endpoint multiplies outbound deliveries. */
export const MAX_ACTIVE_ENDPOINTS_PER_TENANT = 20;

/** Public view of an endpoint. The secret (ciphertext or plaintext) is never part of it. */
export interface WebhookEndpointView {
  id: string;
  url: string;
  eventTypes: string[];
  status: WebhookEndpointStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookEndpointWithSecretView extends WebhookEndpointView {
  secret: string;
}

/**
 * A webhook URL as written to the audit log: origin + path only. Receivers often put
 * credentials or tokens in the query string (`?token=…`) or fragment, and audit rows are
 * immutable, so those parts never reach it. Unparseable input is dropped entirely.
 */
export function auditableWebhookUrl(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
  } catch {
    return '[INVALID_URL]';
  }
}

/** The endpoint view for the audit log (URL without query string or fragment). */
export function toEndpointAuditView(view: WebhookEndpointView): WebhookEndpointView {
  return { ...view, url: auditableWebhookUrl(view.url) };
}
