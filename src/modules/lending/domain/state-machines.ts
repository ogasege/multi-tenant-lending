import type { ApplicationStatus, LoanStatus } from '../../../common/database/schema';
import { InvalidStateTransitionError } from '../../../common/errors/app-error';

export type ApplicationAction = 'assess' | 'approve' | 'reject' | 'withdraw' | 'expire';
export type LoanAction = 'disburse' | 'cancel' | 'settle' | 'write_off';

type TransitionTable<S extends string, A extends string> = Readonly<
  Record<S, Readonly<Partial<Record<A, S>>>>
>;

/**
 * Application lifecycle (SPEC §7.2). ASSESSED → ASSESSED allows re-assessment (e.g. after
 * updated income documents). EXPIRED applies to approvals not disbursed in time.
 */
export const APPLICATION_TRANSITIONS: TransitionTable<ApplicationStatus, ApplicationAction> = {
  SUBMITTED: { assess: 'ASSESSED', reject: 'REJECTED', withdraw: 'WITHDRAWN' },
  ASSESSED: { assess: 'ASSESSED', approve: 'APPROVED', reject: 'REJECTED', withdraw: 'WITHDRAWN' },
  APPROVED: { expire: 'EXPIRED' },
  REJECTED: {},
  WITHDRAWN: {},
  EXPIRED: {},
};

/** Loan lifecycle (SPEC §7.2). Delinquency is derived (DPD), not a status. */
export const LOAN_TRANSITIONS: TransitionTable<LoanStatus, LoanAction> = {
  PENDING_DISBURSEMENT: { disburse: 'ACTIVE', cancel: 'CANCELLED' },
  ACTIVE: { settle: 'CLOSED', write_off: 'WRITTEN_OFF' },
  CLOSED: {},
  CANCELLED: {},
  WRITTEN_OFF: {},
};

function lookup<S extends string, A extends string>(
  table: TransitionTable<S, A>,
  from: S,
  action: A,
): S | undefined {
  const row = Object.hasOwn(table, from) ? table[from] : undefined;
  return row && Object.hasOwn(row, action) ? row[action] : undefined;
}

function nextStatus(
  entity: 'application' | 'loan',
  from: string,
  action: string,
): ApplicationStatus | LoanStatus | undefined {
  return entity === 'application'
    ? lookup(APPLICATION_TRANSITIONS, from as ApplicationStatus, action as ApplicationAction)
    : lookup(LOAN_TRANSITIONS, from as LoanStatus, action as LoanAction);
}

/**
 * Next status for `action` from `from`, per the explicit transition table; throws
 * `InvalidStateTransitionError` (409 INVALID_STATE_TRANSITION) for anything not listed.
 */
export function transition(
  entity: 'application',
  from: ApplicationStatus,
  action: ApplicationAction,
): ApplicationStatus;
export function transition(entity: 'loan', from: LoanStatus, action: LoanAction): LoanStatus;
export function transition(
  entity: 'application' | 'loan',
  from: string,
  action: string,
): ApplicationStatus | LoanStatus {
  const next = nextStatus(entity, from, action);
  if (next === undefined) throw new InvalidStateTransitionError(entity, from, action);
  return next;
}

/** True when `action` is legal from `from`. */
export function canTransition(
  entity: 'application',
  from: ApplicationStatus,
  action: ApplicationAction,
): boolean;
export function canTransition(entity: 'loan', from: LoanStatus, action: LoanAction): boolean;
export function canTransition(
  entity: 'application' | 'loan',
  from: string,
  action: string,
): boolean {
  return nextStatus(entity, from, action) !== undefined;
}
