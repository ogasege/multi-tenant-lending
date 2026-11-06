/**
 * What the worker needs from the operations module to run end of day for one tenant:
 * accrue due interest, apply late fees and refresh DPD as of `asOf` (`YYYY-MM-DD`, the
 * tenant's local business date, a day that is over). Must be idempotent per (tenant, asOf).
 *
 * WorkerModule binds it to the operations module's `EndOfDayService`.
 */
export interface EndOfDayRunner {
  runForTenant(tenantId: string, asOf: string): Promise<EndOfDayOutcome>;
}

/**
 * What the scheduler needs from a run's summary: whether it left work behind. A run that
 * skipped busy loans or had per-loan / per-approval failures is NOT complete and is retried
 * on the next tick (the run is idempotent, so a retry only does what is left).
 */
export interface EndOfDayOutcome {
  loansSkipped: number;
  loansFailed: readonly string[];
  applicationsFailed: readonly string[];
}

export const END_OF_DAY_RUNNER = Symbol('END_OF_DAY_RUNNER');
