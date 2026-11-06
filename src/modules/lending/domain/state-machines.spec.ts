import type { ApplicationStatus, LoanStatus } from '../../../common/database/schema';
import { InvalidStateTransitionError } from '../../../common/errors/app-error';
import { ErrorCode } from '../../../common/errors/error-codes';

import {
  APPLICATION_TRANSITIONS,
  type ApplicationAction,
  canTransition,
  LOAN_TRANSITIONS,
  type LoanAction,
  transition,
} from './state-machines';

const APP_STATUSES = Object.keys(APPLICATION_TRANSITIONS) as ApplicationStatus[];
const APP_ACTIONS: ApplicationAction[] = ['assess', 'approve', 'reject', 'withdraw', 'expire'];
const LOAN_STATUSES = Object.keys(LOAN_TRANSITIONS) as LoanStatus[];
const LOAN_ACTIONS: LoanAction[] = ['disburse', 'cancel', 'settle', 'write_off'];

const LEGAL_APP: [ApplicationStatus, ApplicationAction, ApplicationStatus][] = [
  ['SUBMITTED', 'assess', 'ASSESSED'],
  ['ASSESSED', 'assess', 'ASSESSED'],
  ['ASSESSED', 'approve', 'APPROVED'],
  ['SUBMITTED', 'reject', 'REJECTED'],
  ['ASSESSED', 'reject', 'REJECTED'],
  ['SUBMITTED', 'withdraw', 'WITHDRAWN'],
  ['ASSESSED', 'withdraw', 'WITHDRAWN'],
  ['APPROVED', 'expire', 'EXPIRED'],
];
const LEGAL_LOAN: [LoanStatus, LoanAction, LoanStatus][] = [
  ['PENDING_DISBURSEMENT', 'disburse', 'ACTIVE'],
  ['PENDING_DISBURSEMENT', 'cancel', 'CANCELLED'],
  ['ACTIVE', 'settle', 'CLOSED'],
  ['ACTIVE', 'write_off', 'WRITTEN_OFF'],
];

describe('state machines', () => {
  it.each(LEGAL_APP)('application %s --%s--> %s', (from, action, to) => {
    expect(transition('application', from, action)).toBe(to);
    expect(canTransition('application', from, action)).toBe(true);
  });

  it.each(LEGAL_LOAN)('loan %s --%s--> %s', (from, action, to) => {
    expect(transition('loan', from, action)).toBe(to);
    expect(canTransition('loan', from, action)).toBe(true);
  });

  it('every other application (status, action) pair is illegal', () => {
    let illegal = 0;
    for (const from of APP_STATUSES) {
      for (const action of APP_ACTIONS) {
        if (LEGAL_APP.some(([f, a]) => f === from && a === action)) continue;
        illegal++;
        expect(canTransition('application', from, action)).toBe(false);
        expect(() => transition('application', from, action)).toThrow(InvalidStateTransitionError);
      }
    }
    expect(illegal).toBe(APP_STATUSES.length * APP_ACTIONS.length - LEGAL_APP.length);
  });

  it('every other loan (status, action) pair is illegal', () => {
    for (const from of LOAN_STATUSES) {
      for (const action of LOAN_ACTIONS) {
        if (LEGAL_LOAN.some(([f, a]) => f === from && a === action)) continue;
        expect(canTransition('loan', from, action)).toBe(false);
        expect(() => transition('loan', from, action)).toThrow(InvalidStateTransitionError);
      }
    }
  });

  it('carries a 409 INVALID_STATE_TRANSITION with context', () => {
    try {
      transition('loan', 'CLOSED', 'disburse');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStateTransitionError);
      const e = err as InvalidStateTransitionError;
      expect(e.status).toBe(409);
      expect(e.code).toBe(ErrorCode.INVALID_STATE_TRANSITION);
      expect(e.details).toEqual({ entity: 'loan', from: 'CLOSED', action: 'disburse' });
    }
  });

  it('rejects unknown runtime values and prototype keys', () => {
    expect(() => transition('loan', 'ACTIVE', 'toString' as LoanAction)).toThrow(
      InvalidStateTransitionError,
    );
    expect(() => transition('application', '__proto__' as ApplicationStatus, 'assess')).toThrow(
      InvalidStateTransitionError,
    );
  });
});
