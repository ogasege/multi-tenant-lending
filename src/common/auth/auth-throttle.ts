import { RateLimit } from '../rate-limit/rate-limit.decorators';

/**
 * Stricter rate limit for credential endpoints (login, refresh, sign-up): slows online
 * password guessing and credential stuffing per client IP, on top of account lockout
 * (OWASP Authentication Cheat Sheet).
 */
export const AuthThrottle = () => RateLimit('auth');
