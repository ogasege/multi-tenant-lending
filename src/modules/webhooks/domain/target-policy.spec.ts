import { isPublicAddress, parseWebhookUrl, type UnsafeWebhookTargetError } from './target-policy';

describe('webhook SSRF address policy', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254', // EC2/ECS instance metadata
    '169.254.170.2', // ECS task metadata / credentials endpoint
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '192.0.2.1', // TEST-NET-1
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd00:ec2::254', // EC2 IPv6 metadata
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // same, hex form
    '::ffff:169.254.169.254',
    '::ffff:10.1.2.3',
    '2002:7f00:1::1', // 6to4 wrapping 127.0.0.1
    '64:ff9b::a00:1', // NAT64 wrapping 10.0.0.1
    '2001:db8::1', // documentation
    '::7f00:1', // IPv4-compatible (::/96) loopback
    '::127.0.0.1', // same, dotted form
    '::a9fe:a9fe', // IPv4-compatible 169.254.169.254
    '::808:808', // IPv4-compatible, even wrapping a public address
    '::8.8.8.8', // same, dotted form (ipaddr.js alone reads it as IPv4-mapped)
    '[::7f00:1]',
    '0:0:0:0:0:0:a00:1',
    '::1:0', // anything in ::/96
    'not-an-ip',
    '::1.2.3', // malformed embedded IPv4
  ])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '[2a00:1450:4001::200e]',
  ])('allows public %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it('requires https and rejects credentials and garbage', () => {
    const reason = (url: string) => {
      try {
        parseWebhookUrl(url);
        return 'OK';
      } catch (err) {
        return (err as UnsafeWebhookTargetError).reason;
      }
    };
    expect(reason('https://hooks.example.com/x')).toBe('OK');
    expect(reason('http://hooks.example.com/x')).toBe('NOT_HTTPS');
    expect(reason('ftp://hooks.example.com')).toBe('NOT_HTTPS');
    expect(reason('https://user:pw@hooks.example.com')).toBe('CREDENTIALS_IN_URL');
    expect(reason('not a url')).toBe('INVALID_URL');
    expect(reason(`https://example.com/${'a'.repeat(2100)}`)).toBe('INVALID_URL');
  });
});
