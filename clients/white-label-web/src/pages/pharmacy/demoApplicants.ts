/**
 * Demo applicants with a known credit outcome, written by `make seed` to
 * demo-brands/demo-applicants.json (keyed by lender slug). The seed scores candidate
 * national ids with the real mock bureau and scorecard of THIS database, so each entry's
 * outcome holds for its stated request (checkout product, cart amount, term). A national id
 * registers once per lender: a used one answers 409.
 */
import type { RegisterCustomerRequest } from '../../api/types';

export type DemoOutcome = 'APPROVE' | 'COUNTER_OFFER' | 'DECLINE';

export interface DemoApplicant {
  lender: string;
  expectedDecision: DemoOutcome;
  scenario: string;
  bureauScore: number;
  request: { productCode: string; principal: string; term: number };
  registration: Omit<RegisterCustomerRequest, 'password'>;
}

export interface DemoApplicantsFile {
  lenders: Record<string, { cellRegion: string; applicants: DemoApplicant[] } | undefined>;
}

// Optional file: absent until the stack has been seeded, so it is globbed, not imported.
const files = import.meta.glob<DemoApplicantsFile>('../../../demo-brands/demo-applicants.json', {
  eager: true,
  import: 'default',
});
const BUNDLED: DemoApplicantsFile | undefined = Object.values(files)[0];

export const OUTCOMES: readonly DemoOutcome[] = ['APPROVE', 'COUNTER_OFFER', 'DECLINE'];

/** Applicants for `slug` with outcome `outcome`, skipping national ids already used. */
export function demoApplicantsFor(
  slug: string,
  outcome: DemoOutcome,
  used: ReadonlySet<string>,
  file: DemoApplicantsFile | undefined = BUNDLED,
): DemoApplicant[] {
  return (file?.lenders[slug]?.applicants ?? []).filter(
    (a) => a.expectedDecision === outcome && !used.has(a.registration.nationalId),
  );
}

export function hasDemoApplicants(
  slug: string,
  file: DemoApplicantsFile | undefined = BUNDLED,
): boolean {
  return (file?.lenders[slug]?.applicants.length ?? 0) > 0;
}

/** A policy-compliant password for a demo registration (12+, upper, lower, digit). */
export function demoPassword(): string {
  const digits = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b % 10).join('');
  return `Demo-${digits}-Pass`;
}
