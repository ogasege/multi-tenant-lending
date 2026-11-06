/**
 * Credit bureau port (hexagonal boundary). Adapters: `MockCreditBureau` for demo/test;
 * a CRC / FirstCentral (NG) or BCEAO-licensed bureau (WAEMU) adapter in production.
 */
export const BUREAU_MIN_SCORE = 300;
export const BUREAU_MAX_SCORE = 850;

export interface BureauQuery {
  /**
   * Keyed HMAC of the national identifier (BVN/NIN in Nigeria, NINEA/CNI in Senegal).
   * The raw identifier never crosses this boundary.
   */
  nationalIdHmac: string;
}

export interface BureauReport {
  /** Score on the 300–850 scale. */
  score: number;
  /** Bureau reports an account currently in arrears / default. */
  delinquent: boolean;
  /** Adapter identifier, persisted with the assessment for reproducibility. */
  provider: string;
}

export interface CreditBureauPort {
  fetchReport(query: BureauQuery): Promise<BureauReport>;
}
