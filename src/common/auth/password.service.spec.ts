import { ARGON2_OPTIONS, DUMMY_PASSWORD_HASH, PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and the OWASP parameters (m=19456, t=2, p=1)', async () => {
    const hash = await service.hash('Correct-Horse-9');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('salts every hash (same password, different hashes)', async () => {
    const [a, b] = await Promise.all([
      service.hash('Same-Password-1'),
      service.hash('Same-Password-1'),
    ]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await service.hash('Correct-Horse-9');
    await expect(service.verify(hash, 'Correct-Horse-9')).resolves.toBe(true);
    await expect(service.verify(hash, 'correct-horse-9')).resolves.toBe(false);
  });

  it('returns false for an unknown account, after doing the same argon2 work', async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    await expect(service.verify(null, 'anything')).resolves.toBe(false);
  });

  it('treats a malformed stored hash as a mismatch, not an error', async () => {
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });
});
