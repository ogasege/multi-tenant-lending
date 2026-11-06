import { isLocked, LOCKOUT_DURATION_MS, MAX_FAILED_LOGINS, registerFailedLogin } from './lockout';

describe('login lockout', () => {
  const now = new Date('2026-11-06T10:00:00Z');

  it('locks for 15 minutes on the 5th consecutive failure', () => {
    let state = { failedLoginCount: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < MAX_FAILED_LOGINS; i++) {
      state = registerFailedLogin(state, now);
      expect(state).toEqual({ failedLoginCount: i, lockedUntil: null });
    }
    state = registerFailedLogin(state, now);
    expect(state.lockedUntil?.getTime()).toBe(now.getTime() + LOCKOUT_DURATION_MS);
    expect(isLocked(state, now)).toBe(true);
    expect(isLocked(state, new Date(now.getTime() + LOCKOUT_DURATION_MS))).toBe(false);
  });

  it('starts a fresh window once the lock has expired', () => {
    const expired = { failedLoginCount: 0, lockedUntil: new Date(now.getTime() - 1) };
    expect(registerFailedLogin(expired, now)).toEqual({ failedLoginCount: 1, lockedUntil: null });
  });
});
