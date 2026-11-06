import ipaddr from 'ipaddr.js';

/**
 * Rate-limit key for an anonymous client. IPv6 clients are grouped by their /64 prefix: a single
 * subscriber is normally assigned a whole /64, so per-address keys would let one client rotate
 * through billions of addresses and bypass the limit.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip || !ipaddr.isValid(ip)) return 'unknown';
  const addr = ipaddr.process(ip); // also unwraps IPv4-mapped IPv6 (::ffff:1.2.3.4)
  if (addr.kind() === 'ipv4') return addr.toString();
  const parts = (addr as ipaddr.IPv6).parts.slice(0, 4);
  return `${parts.map((p) => p.toString(16)).join(':')}::/64`;
}
