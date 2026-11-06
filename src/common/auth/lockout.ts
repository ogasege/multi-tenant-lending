/**
 * SPEC §5: lock an account for 15 minutes after 5 consecutive failed logins.
 *
 * A locked account answers exactly like a wrong password (401 INVALID_CREDENTIALS), even for
 * the correct password: a distinct 423 would confirm that the account exists (and that an
 * attacker reached the threshold). The owner is told out of band instead — sign-in emits the
 * `auth.account_locked` audit entry and outbox event for the notification service.
 */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface LockoutState {
  failedLoginCount: number;
  lockedUntil: Date | null;
}

export function isLocked(state: LockoutState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

/**
 * State after one more failed attempt. A lock that has expired starts a fresh window; reaching
 * the threshold locks the account and resets the counter for the next window.
 */
export function registerFailedLogin(state: LockoutState, now: Date): LockoutState {
  const expired = state.lockedUntil !== null && !isLocked(state, now);
  const failedLoginCount = (expired ? 0 : state.failedLoginCount) + 1;
  if (failedLoginCount >= MAX_FAILED_LOGINS) {
    return { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_DURATION_MS) };
  }
  return { failedLoginCount, lockedUntil: expired ? null : state.lockedUntil };
}
