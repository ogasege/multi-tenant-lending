import { UnsafeWebhookTargetError } from '../domain/target-policy';

import { type HostResolver, resolveSafeTarget } from './safe-target-resolver';

const zone =
  (records: Record<string, string[]>): HostResolver =>
  (host) => {
    const addresses = records[host];
    if (!addresses) return Promise.reject(new Error('ENOTFOUND'));
    return Promise.resolve(
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  };

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof UnsafeWebhookTargetError ? err.reason : 'other';
  }
}

describe('resolveSafeTarget', () => {
  it('pins the checked public address and keeps the hostname for Host/SNI', async () => {
    const target = await resolveSafeTarget('https://hooks.example.com:8443/in?x=1', {
      resolver: zone({ 'hooks.example.com': ['93.184.216.34'] }),
    });
    expect(target.hostname).toBe('hooks.example.com');
    expect(target.address).toEqual({ address: '93.184.216.34', family: 4 });
    expect(target.url.port).toBe('8443');
  });

  it('refuses a host whose records mix public and private addresses', async () => {
    const resolver = zone({ 'mixed.example.com': ['93.184.216.34', '10.0.0.5'] });
    expect(await rejection(resolveSafeTarget('https://mixed.example.com', { resolver }))).toBe(
      'FORBIDDEN_ADDRESS',
    );
  });

  it('resolves exactly once, so a rebinding answer after the check is never used', async () => {
    const answers = [['93.184.216.34'], ['169.254.169.254']];
    const resolver = vi.fn<HostResolver>((_host) => {
      const next = answers.shift() ?? [];
      return Promise.resolve(next.map((address) => ({ address, family: 4 as const })));
    });
    const target = await resolveSafeTarget('https://rebind.example.com', { resolver });
    expect(resolver).toHaveBeenCalledTimes(1);
    // The connection uses this pinned address; the metadata IP the zone would serve next is
    // never looked up for this delivery.
    expect(target.address.address).toBe('93.184.216.34');
    // The NEXT delivery re-checks and is refused.
    expect(await rejection(resolveSafeTarget('https://rebind.example.com', { resolver }))).toBe(
      'FORBIDDEN_ADDRESS',
    );
  });

  it.each([
    'https://127.0.0.1/',
    'https://2130706433/', // decimal 127.0.0.1, normalised by the URL parser
    'https://0x7f.0.0.1/',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:a9fe:a9fe]/', // 169.254.169.254
    'https://169.254.169.254/latest/meta-data/',
  ])('refuses the IP literal %s', async (url) => {
    // An IP literal "resolves" to itself (the system resolver echoes it).
    const resolver: HostResolver = (host) =>
      Promise.resolve([{ address: host, family: host.includes(':') ? 6 : 4 }]);
    expect(await rejection(resolveSafeTarget(url, { resolver }))).toBe('FORBIDDEN_ADDRESS');
  });

  it('refuses unresolvable hosts and non-https URLs before any lookup', async () => {
    const resolver = vi.fn(zone({}));
    expect(await rejection(resolveSafeTarget('https://nx.example.com', { resolver }))).toBe(
      'UNRESOLVABLE',
    );
    expect(await rejection(resolveSafeTarget('http://hooks.example.com', { resolver }))).toBe(
      'NOT_HTTPS',
    );
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('allows private targets only with the explicit test override', async () => {
    const resolver = zone({ localhost: ['127.0.0.1'] });
    expect(await rejection(resolveSafeTarget('https://localhost:9443', { resolver }))).toBe(
      'FORBIDDEN_ADDRESS',
    );
    const target = await resolveSafeTarget('https://localhost:9443', {
      resolver,
      allowPrivate: true,
    });
    expect(target.address.address).toBe('127.0.0.1');
  });
});
