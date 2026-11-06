import type { Direction, JournalKind } from '../../../common/database/schema';
import { ValidationError } from '../../../common/errors/app-error';
import type { AccountCode } from '../chart-of-accounts';

/** One side of a double-entry journal entry, in minor units of the entry's currency. */
export interface JournalLine {
  account: AccountCode;
  direction: Direction;
  amount: bigint;
}

/** A journal entry to post: business-level dedupe by `idempotencyRef` (unique per tenant). */
export interface JournalEntryDraft {
  kind: JournalKind;
  loanId: string | null;
  currency: string;
  /** Business date the entry belongs to (`YYYY-MM-DD`). */
  effectiveDate: string;
  /** e.g. `disbursement:<loanId>`, `interest:<instalmentId>`, `repayment:<repaymentId>`. */
  idempotencyRef: string;
  description: string;
  lines: readonly JournalLine[];
  /** Entry this one (partially) reverses, for `REVERSAL` entries. */
  reversesEntryId?: string;
}

/**
 * Double-entry invariants, checked in code before anything is written (the deferred
 * `postings_balanced` trigger enforces the same rule at COMMIT as the last line of defence):
 *
 * - at least two lines;
 * - every amount strictly positive (a zero line is omitted, never posted);
 * - Σ debits = Σ credits.
 *
 * Throws `ValidationError` naming the broken rule; such an error is a programming bug in a
 * posting rule, never a client mistake.
 */
export function assertBalanced(lines: readonly JournalLine[]): void {
  if (lines.length < 2) {
    throw new ValidationError('A journal entry needs at least two postings');
  }
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    if (line.amount <= 0n) {
      throw new ValidationError(`Posting to ${line.account} must have a positive amount`);
    }
    if (line.direction === 'DEBIT') debits += line.amount;
    else credits += line.amount;
  }
  if (debits !== credits) {
    throw new ValidationError(`Journal entry is unbalanced: debits ${debits} ≠ credits ${credits}`);
  }
}

/** Net balance of an account in its normal direction: debit-normal ⇒ Dr − Cr, else Cr − Dr. */
export function normalBalance(normal: Direction, debits: bigint, credits: bigint): bigint {
  return normal === 'DEBIT' ? debits - credits : credits - debits;
}
