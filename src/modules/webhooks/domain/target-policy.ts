import ipaddr from 'ipaddr.js';

/**
 * SSRF policy for webhook targets (OWASP API7:2023). A webhook URL is attacker-controlled
 * input that our worker will connect to, so it must never reach the platform's own network:
 * loopback, RFC 1918, link-local (incl. the 169.254.169.254 / fd00:ec2::254 instance metadata
 * services), CGNAT, unique-local, multicast, reserved and documentation ranges, and IPv6
 * transition prefixes that embed an IPv4 address (6to4, Teredo, NAT64, IPv4-compatible
 * `::/96`) are all refused.
 *
 * It is an ALLOW-list: only addresses that ipaddr.js classifies as global `unicast` pass, so a
 * range we forgot to list is refused rather than allowed.
 */

export type TargetRejection =
  'NOT_HTTPS' | 'INVALID_URL' | 'CREDENTIALS_IN_URL' | 'FORBIDDEN_ADDRESS' | 'UNRESOLVABLE';

export class UnsafeWebhookTargetError extends Error {
  constructor(
    readonly reason: TargetRejection,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeWebhookTargetError';
  }
}

/**
 * Whether `ip` is a public, globally routable unicast address. IPv4-mapped IPv6
 * (`::ffff:10.0.0.1`) is unwrapped first, so the mapped IPv4 range decides.
 *
 * The deprecated IPv4-COMPATIBLE block `::/96` (first 96 bits zero, e.g. `::7f00:1`, which
 * WHATWG URL produces from `[::127.0.0.1]`) is refused outright: ipaddr.js classifies most
 * of it as `unicast`, and some stacks still route it to the embedded IPv4 address. It also
 * covers `::` and `::1`.
 */
export function isPublicAddress(ip: string): boolean {
  const literal = canonicalIPv6(ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip);
  if (literal === undefined || !ipaddr.isValid(literal)) return false;
  let addr = ipaddr.parse(literal);
  if (addr instanceof ipaddr.IPv6) {
    if (addr.parts.slice(0, 6).every((part) => part === 0)) return false;
    if (addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
  }
  return addr.range() === 'unicast';
}

/**
 * IPv6 literals with an embedded dotted quad are re-serialised by the WHATWG URL parser
 * first (`::8.8.8.8` → `::808:808`): ipaddr.js reads `::a.b.c.d` as IPv4-MAPPED, which would
 * hide an IPv4-compatible address from the `::/96` check. Anything else is returned as is;
 * `undefined` = not parseable.
 */
function canonicalIPv6(literal: string): string | undefined {
  if (!literal.includes(':') || !literal.includes('.')) return literal;
  try {
    const host = new URL(`https://[${literal}]/`).hostname;
    return host.slice(1, -1);
  } catch {
    return undefined;
  }
}

const MAX_URL_LENGTH = 2048;

/**
 * Syntactic checks done before any DNS lookup: absolute `https:` URL, no userinfo (which
 * would be sent as Basic credentials and is a classic parser-confusion vector), bounded
 * length. Returns the parsed URL; the host is checked separately against DNS.
 */
export function parseWebhookUrl(raw: string): URL {
  if (raw.length > MAX_URL_LENGTH) {
    throw new UnsafeWebhookTargetError('INVALID_URL', 'Webhook URL is too long');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookTargetError('INVALID_URL', 'Webhook URL is not a valid absolute URL');
  }
  if (url.protocol !== 'https:') {
    throw new UnsafeWebhookTargetError('NOT_HTTPS', 'Webhook URL must use https://');
  }
  if (url.username || url.password) {
    throw new UnsafeWebhookTargetError(
      'CREDENTIALS_IN_URL',
      'Webhook URL must not contain credentials',
    );
  }
  if (!url.hostname) {
    throw new UnsafeWebhookTargetError('INVALID_URL', 'Webhook URL has no host');
  }
  return url;
}

/** URL hostname without the brackets WHATWG URL keeps around IPv6 literals. */
export function bareHostname(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
