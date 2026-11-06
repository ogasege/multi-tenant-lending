/**
 * Stable, machine-readable error codes. White-label front-ends localise messages by code,
 * so codes are part of the public API contract: add new ones, never rename or reuse.
 */
export const ErrorCode = {
  // 400 / 422 — request validation and business rules
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  AMOUNT_OUT_OF_PRODUCT_RANGE: 'AMOUNT_OUT_OF_PRODUCT_RANGE',
  TERM_OUT_OF_PRODUCT_RANGE: 'TERM_OUT_OF_PRODUCT_RANGE',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  PRODUCT_NOT_ACTIVE: 'PRODUCT_NOT_ACTIVE',
  KYC_NOT_VERIFIED: 'KYC_NOT_VERIFIED',
  ASSESSMENT_REQUIRED: 'ASSESSMENT_REQUIRED',
  ASSESSMENT_DECLINED: 'ASSESSMENT_DECLINED',
  APPROVED_AMOUNT_EXCEEDS_REQUEST: 'APPROVED_AMOUNT_EXCEEDS_REQUEST',
  /** A counter-offer approval above the assessment's max affordable principal. */
  APPROVED_AMOUNT_EXCEEDS_AFFORDABLE: 'APPROVED_AMOUNT_EXCEEDS_AFFORDABLE',
  APPLICATION_EXPIRED: 'APPLICATION_EXPIRED',
  APR_EXCEEDS_CAP: 'APR_EXCEEDS_CAP',
  REPAYMENT_EXCEEDS_PAYOFF: 'REPAYMENT_EXCEEDS_PAYOFF',
  /**
   * A repayment value date outside [max(disbursement, latest repayment, today − backdate
   * window), business today].
   */
  VALUE_DATE_OUT_OF_RANGE: 'VALUE_DATE_OUT_OF_RANGE',
  /** A statement-backed repayment channel (anything but CASH) without its reference. */
  EXTERNAL_REFERENCE_REQUIRED: 'EXTERNAL_REFERENCE_REQUIRED',
  /** The payee is not one the principal may direct the disbursement to. */
  PAYEE_NOT_ALLOWED: 'PAYEE_NOT_ALLOWED',
  /** The checkout order reference is unknown to the procurement platform. */
  CHECKOUT_ORDER_NOT_FOUND: 'CHECKOUT_ORDER_NOT_FOUND',
  /** The requested principal is above the checkout order's total. */
  ORDER_AMOUNT_EXCEEDED: 'ORDER_AMOUNT_EXCEEDED',
  /** The checkout order was placed by another customer than the applicant. */
  ORDER_NOT_FOR_APPLICANT: 'ORDER_NOT_FOR_APPLICANT',
  /** An `externalOrderReference` sent for a BORROWER-mode (not checkout) product. */
  ORDER_REFERENCE_NOT_ALLOWED: 'ORDER_REFERENCE_NOT_ALLOWED',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  UNSAFE_WEBHOOK_URL: 'UNSAFE_WEBHOOK_URL',
  WEBHOOK_ENDPOINT_LIMIT_REACHED: 'WEBHOOK_ENDPOINT_LIMIT_REACHED',
  /** The request belongs to a tenant whose home region is served by another cell. */
  WRONG_CELL: 'WRONG_CELL',

  // 401 / 403
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  FORBIDDEN: 'FORBIDDEN',
  SOD_VIOLATION: 'SOD_VIOLATION',
  INSTITUTION_SUSPENDED: 'INSTITUTION_SUSPENDED',

  // 421 — the token was issued by another cell (SPEC §4.1); retry at `apiBaseUrl`
  MISDIRECTED_REQUEST: 'MISDIRECTED_REQUEST',

  // 404 — also returned for other tenants' resources (no existence oracle)
  NOT_FOUND: 'NOT_FOUND',

  // 409 — state and concurrency
  CONFLICT: 'CONFLICT',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  DUPLICATE: 'DUPLICATE',
  /** Sign-up details clash with an existing account (deliberately not saying which). */
  REGISTRATION_CONFLICT: 'REGISTRATION_CONFLICT',
  /** The checkout order already backs a live (submitted, assessed or approved) application. */
  ORDER_ALREADY_FINANCED: 'ORDER_ALREADY_FINANCED',

  // 429 / 5xx
  RATE_LIMITED: 'RATE_LIMITED',
  DISBURSEMENT_PROVIDER_FAILED: 'DISBURSEMENT_PROVIDER_FAILED',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
