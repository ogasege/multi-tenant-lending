import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_POLICY = 'rateLimitPolicy';
export const SKIP_RATE_LIMIT = 'skipRateLimit';

/** `auth`: stricter per-IP budget for credential endpoints (login, refresh, sign-up). */
export type RateLimitPolicyName = 'auth';

export const RateLimit = (policy: RateLimitPolicyName) => SetMetadata(RATE_LIMIT_POLICY, policy);

/** For infrastructure endpoints polled by load balancers (health checks). */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
