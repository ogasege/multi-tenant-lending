import type { DpdBucket } from '../../../common/database/schema';

import { daysBetween, type IsoDate } from './dates';

/**
 * Days past due: whole days from the oldest unpaid instalment's due date to `asOf`.
 * An instalment due today is not yet late (0); no unpaid instalment ⇒ 0.
 */
export function daysPastDue(oldestUnpaidDueDate: IsoDate | null, asOf: IsoDate): number {
  if (oldestUnpaidDueDate === null) return 0;
  return Math.max(0, daysBetween(oldestUnpaidDueDate, asOf));
}

/**
 * Delinquency bucket (SPEC §7.2): 0 ⇒ CURRENT, 1–30, 31–60, 61–90, > 90 ⇒ DPD_90_PLUS.
 */
export function dpdBucket(dpd: number): DpdBucket {
  if (dpd <= 0) return 'CURRENT';
  if (dpd <= 30) return 'DPD_1_30';
  if (dpd <= 60) return 'DPD_31_60';
  if (dpd <= 90) return 'DPD_61_90';
  return 'DPD_90_PLUS';
}
