import { Injectable } from '@nestjs/common';

import type { Tx } from '../../../common/database/database.tokens';
import type { DpdBucket } from '../../../common/database/schema';
import { LedgerService } from '../../ledger/application/ledger.service';
import { interestAccrualLines, interestWaiverLines } from '../../ledger/domain/posting-rules';
import { daysPastDue, dpdBucket, type IsoDate } from '../domain';
import {
  type InstalmentRow,
  type LoanRow,
  LoansRepository,
} from '../infrastructure/loans.repository';

import { oldestUnpaidDueDate } from './instalment-state';

/** Journal idempotency reference of an instalment's interest recognition. */
const interestRef = (instalmentId: string): string => `interest:${instalmentId}`;

/**
 * Accounting steps shared by repayments and end-of-day. All of them run in the caller's
 * transaction with the loan row already locked.
 */
@Injectable()
export class LoanAccounting {
  constructor(
    private readonly ledger: LedgerService,
    private readonly loans: LoansRepository,
  ) {}

  /**
   * Recognises an instalment's interest (Dr 1110 / Cr 4000, SPEC §8) once: on its due date
   * (EOD) or earlier when a payment reaches it, so the interest receivable is never credited
   * before it was debited. Marks `interest_accrued`; returns the amount recognised (0 when it
   * already was). The journal ref `interest:<instalmentId>` makes a repeat a no-op even if
   * the flag were lost.
   */
  async recogniseInterest(
    tx: Tx,
    loan: LoanRow,
    instalment: InstalmentRow,
    effectiveDate: IsoDate,
  ): Promise<bigint> {
    if (instalment.interest_accrued) return 0n;
    const amount = instalment.interest_due - instalment.interest_waived;
    if (amount > 0n) {
      await this.ledger.post(tx, {
        kind: 'INTEREST_ACCRUAL',
        loanId: loan.id,
        currency: loan.currency,
        effectiveDate,
        idempotencyRef: interestRef(instalment.id),
        description: `Interest due on instalment ${instalment.seq} of ${loan.reference}`,
        lines: interestAccrualLines(amount),
      });
    }
    await this.loans.updateInstalment(tx, instalment.id, { interest_accrued: true });
    return amount;
  }

  /**
   * Early settlement waives future interest. If an instalment's interest had already been
   * recognised (a prepayment reached it), the waived part is reversed (Dr 4000 / Cr 1110)
   * against that accrual so the receivable returns to exactly zero.
   */
  async reverseWaivedInterest(
    tx: Tx,
    loan: LoanRow,
    instalment: InstalmentRow,
    waived: bigint,
    effectiveDate: IsoDate,
  ): Promise<void> {
    if (!instalment.interest_accrued || waived <= 0n) return;
    const accrualId = await this.ledger.entryIdByRef(tx, interestRef(instalment.id));
    await this.ledger.post(tx, {
      kind: 'REVERSAL',
      loanId: loan.id,
      currency: loan.currency,
      effectiveDate,
      idempotencyRef: `interest-waiver:${instalment.id}`,
      description: `Interest waived on early settlement, instalment ${instalment.seq} of ${loan.reference}`,
      lines: interestWaiverLines(waived),
      reversesEntryId: accrualId,
    });
  }

  /**
   * Days past due and bucket as of `asOf`, from the oldest instalment still owing anything
   * (SPEC §7.2); writes them only when they changed.
   */
  async refreshDelinquency(
    tx: Tx,
    loan: LoanRow,
    instalments: readonly InstalmentRow[],
    asOf: IsoDate,
  ): Promise<{ daysPastDue: number; bucket: DpdBucket; changed: boolean }> {
    const dpd = daysPastDue(oldestUnpaidDueDate(instalments), asOf);
    const bucket = dpdBucket(dpd);
    const changed = dpd !== loan.days_past_due || bucket !== loan.dpd_bucket;
    if (changed) await this.loans.setDelinquency(tx, loan.id, dpd, bucket);
    return { daysPastDue: dpd, bucket, changed };
  }
}
