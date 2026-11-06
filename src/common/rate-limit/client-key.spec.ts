import { clientKey } from './client-key';

describe('clientKey', () => {
  it('keeps IPv4 addresses and unwraps IPv4-mapped IPv6', () => {
    expect(clientKey('102.89.1.7')).toBe('102.89.1.7');
    expect(clientKey('::ffff:102.89.1.7')).toBe('102.89.1.7');
  });

  it('groups IPv6 clients by /64 so address rotation cannot bypass the limit', () => {
    expect(clientKey('2c0f:f5c0:1:2::abcd')).toBe(clientKey('2c0f:f5c0:1:2:ffff:1:2:3'));
    expect(clientKey('2c0f:f5c0:1:2::abcd')).not.toBe(clientKey('2c0f:f5c0:1:3::abcd'));
  });

  it('collapses missing or invalid addresses into one bucket', () => {
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('not-an-ip')).toBe('unknown');
  });
});
