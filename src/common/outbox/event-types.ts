/**
 * Every domain event the system emits. It is the outbox's event vocabulary and the list of
 * event types a lender may subscribe a webhook endpoint to, so a misspelt name fails at
 * compile time (publishers) or with 400 (subscribers) instead of silently never matching.
 */
export const DOMAIN_EVENT_TYPES = [
  'auth.account_locked',
  'customer.registered',
  'institution.branding_updated',
  'institution.registered',
  'institution.status_changed',
  'loan.cancelled',
  'loan.closed',
  'loan.delinquency_changed',
  'loan.disbursed',
  'loan.late_fee_assessed',
  'loan.repayment_received',
  'loan_application.approved',
  'loan_application.assessed',
  'loan_application.expired',
  'loan_application.rejected',
  'loan_application.submitted',
  'loan_application.withdrawn',
  'loan_product.created',
  'loan_product.status_changed',
  'loan_product.version_created',
  'user.created',
  'user.updated',
  'webhook_endpoint.created',
  'webhook_endpoint.disabled',
  'webhook_endpoint.secret_rotated',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
