import { createHmac } from 'node:crypto';

import {
  BUREAU_MAX_SCORE,
  BUREAU_MIN_SCORE,
  type BureauQuery,
  type BureauReport,
  type CreditBureauPort,
} from './bureau.port';

/** Mock reports below this score are flagged delinquent. */
export const MOCK_DELINQUENCY_THRESHOLD = 450;

const SCORE_RANGE = BUREAU_MAX_SCORE - BUREAU_MIN_SCORE + 1; // 551 distinct scores

/**
 * Deterministic mock bureau: score = 300 + (first 48 bits of
 * HMAC-SHA256(secret, nationalIdHmac)) mod 551, so the same applicant always gets the same
 * score and nothing is random. Delinquent when score < 450. Fixture overrides (keyed by
 * national-id HMAC) let tests and demos pin specific outcomes.
 */
export class MockCreditBureau implements CreditBureauPort {
  static readonly PROVIDER = 'mock-bureau-v1';

  constructor(
    private readonly secret: string,
    private readonly overrides: ReadonlyMap<string, Omit<BureauReport, 'provider'>> = new Map(),
  ) {}

  /** Synchronous core of {@link fetchReport}; pure given the constructor arguments. */
  reportFor(nationalIdHmac: string): BureauReport {
    const override = this.overrides.get(nationalIdHmac);
    if (override) return { ...override, provider: MockCreditBureau.PROVIDER };
    const digest = createHmac('sha256', this.secret).update(nationalIdHmac, 'utf8').digest();
    const score = BUREAU_MIN_SCORE + (digest.readUIntBE(0, 6) % SCORE_RANGE);
    return {
      score,
      delinquent: score < MOCK_DELINQUENCY_THRESHOLD,
      provider: MockCreditBureau.PROVIDER,
    };
  }

  fetchReport(query: BureauQuery): Promise<BureauReport> {
    return Promise.resolve(this.reportFor(query.nationalIdHmac));
  }
}
