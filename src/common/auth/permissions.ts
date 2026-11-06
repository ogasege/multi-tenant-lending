import type { UserRole } from '../database/schema';

/**
 * Permission catalogue. Routes declare the permission they need; roles map to permissions
 * here, in one reviewable place (SPEC §5). New roles or per-tenant custom roles only change
 * this mapping, never the controllers.
 */
export const Permission = {
  INSTITUTION_MANAGE: 'institution:manage',
  USER_MANAGE: 'user:manage',
  PRODUCT_READ: 'product:read',
  PRODUCT_WRITE: 'product:write',
  CUSTOMER_READ: 'customer:read',
  APPLICATION_CREATE: 'application:create',
  APPLICATION_READ: 'application:read',
  APPLICATION_ASSESS: 'application:assess',
  APPLICATION_DECIDE: 'application:decide',
  LOAN_READ: 'loan:read',
  LOAN_DISBURSE: 'loan:disburse',
  REPAYMENT_CREATE: 'repayment:create',
  LEDGER_READ: 'ledger:read',
  AUDIT_READ: 'audit:read',
  OPERATIONS_RUN: 'operations:run',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

const P = Permission;

export const ROLE_PERMISSIONS: Readonly<Record<UserRole, readonly Permission[]>> = {
  INSTITUTION_ADMIN: [
    P.INSTITUTION_MANAGE,
    P.USER_MANAGE,
    P.PRODUCT_READ,
    P.PRODUCT_WRITE,
    P.CUSTOMER_READ,
    P.APPLICATION_READ,
    P.LOAN_READ,
    P.LEDGER_READ,
    P.AUDIT_READ,
    P.OPERATIONS_RUN,
  ],
  CREDIT_OFFICER: [
    P.PRODUCT_READ,
    P.CUSTOMER_READ,
    P.APPLICATION_CREATE,
    P.APPLICATION_READ,
    P.APPLICATION_ASSESS,
    P.APPLICATION_DECIDE,
    P.LOAN_READ,
  ],
  FINANCE_OFFICER: [
    P.PRODUCT_READ,
    P.CUSTOMER_READ,
    P.APPLICATION_READ,
    P.LOAN_READ,
    P.LOAN_DISBURSE,
    P.REPAYMENT_CREATE,
    P.LEDGER_READ,
    P.AUDIT_READ,
  ],
  AUDITOR: [
    P.PRODUCT_READ,
    P.CUSTOMER_READ,
    P.APPLICATION_READ,
    P.LOAN_READ,
    P.LEDGER_READ,
    P.AUDIT_READ,
  ],
  // Customers hold these only for their OWN records — use cases enforce ownership.
  // No REPAYMENT_CREATE: a self-attested repayment would let a borrower close a loan without
  // paying. Customer-initiated payments must be provider-verified payment intents (future).
  CUSTOMER: [
    P.PRODUCT_READ,
    P.CUSTOMER_READ,
    P.APPLICATION_CREATE,
    P.APPLICATION_READ,
    P.LOAN_READ,
  ],
};

export function roleHas(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
