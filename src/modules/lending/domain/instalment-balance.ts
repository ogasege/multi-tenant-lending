import { ValidationError } from '../../../common/errors/app-error';

import type { IsoDate } from './dates';

/**
 * Contractual and settled amounts of one instalment, mirroring `loan_instalments`
 * (all minor units). `interestWaived` reduces what is owed without a cash payment.
 */
export interface InstalmentBalance {
  seq: number;
  dueDate: IsoDate;
  principalDue: bigint;
  principalPaid: bigint;
  interestDue: bigint;
  interestPaid: bigint;
  interestWaived?: bigint;
  feeDue: bigint;
  feePaid: bigint;
  penaltyDue: bigint;
  penaltyPaid: bigint;
}

/** Outstanding amount of each component of one instalment. */
export interface ComponentAmounts {
  penalty: bigint;
  fee: bigint;
  interest: bigint;
  principal: bigint;
}

/** Outstanding (due − paid − waived) amount per component; validates non-negative inputs. */
export function outstandingOf(row: InstalmentBalance): ComponentAmounts {
  const waived = row.interestWaived ?? 0n;
  const pairs: [keyof ComponentAmounts, bigint, bigint][] = [
    ['penalty', row.penaltyDue, row.penaltyPaid],
    ['fee', row.feeDue, row.feePaid],
    ['interest', row.interestDue, row.interestPaid + waived],
    ['principal', row.principalDue, row.principalPaid],
  ];
  for (const [name, due, settled] of pairs) {
    if (due < 0n || settled < 0n || waived < 0n || settled > due) {
      throw new ValidationError(`Instalment ${row.seq} has inconsistent ${name} amounts`, [
        { field: `instalments[${row.seq}].${name}`, message: 'paid must be within 0..due' },
      ]);
    }
  }
  return {
    penalty: row.penaltyDue - row.penaltyPaid,
    fee: row.feeDue - row.feePaid,
    interest: row.interestDue - row.interestPaid - waived,
    principal: row.principalDue - row.principalPaid,
  };
}

/** Instalments ordered oldest first: by due date, then by seq. Does not mutate. */
export function oldestFirst<T extends { seq: number; dueDate: IsoDate }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.dueDate === b.dueDate) return a.seq - b.seq;
    return a.dueDate < b.dueDate ? -1 : 1;
  });
}
