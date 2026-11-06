import { lookup as dnsLookup } from 'node:dns/promises';

import {
  bareHostname,
  isPublicAddress,
  parseWebhookUrl,
  UnsafeWebhookTargetError,
} from '../domain/target-policy';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host to every address it currently maps to (A + AAAA). */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: HostResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, order: 'verbatim' });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/** A webhook target that passed the SSRF policy, pinned to the address that was checked. */
export interface SafeTarget {
  url: URL;
  /** Hostname for the Host header and TLS SNI / certificate verification. */
  hostname: string;
  address: ResolvedAddress;
}

export interface ResolveOptions {
  /** Test-only (WEBHOOK_ALLOW_PRIVATE_TARGETS): skip the private-range check. */
  allowPrivate?: boolean;
  resolver?: HostResolver;
}

/**
 * Validates a webhook URL and resolves its host ONCE, refusing it when ANY resolved address is
 * non-public (an attacker-controlled zone can mix public and private records). The caller
 * must connect to the returned `address` — never re-resolve the name — so a DNS rebinding
 * between this check and the connection cannot redirect the request to an internal host.
 */
export async function resolveSafeTarget(
  rawUrl: string,
  opts: ResolveOptions = {},
): Promise<SafeTarget> {
  const url = parseWebhookUrl(rawUrl);
  const hostname = bareHostname(url);
  let addresses: ResolvedAddress[];
  try {
    addresses = await (opts.resolver ?? systemResolver)(hostname);
  } catch {
    throw new UnsafeWebhookTargetError('UNRESOLVABLE', `Host ${hostname} could not be resolved`);
  }
  const first = addresses[0];
  if (!first) {
    throw new UnsafeWebhookTargetError('UNRESOLVABLE', `Host ${hostname} has no addresses`);
  }
  if (!opts.allowPrivate) {
    const forbidden = addresses.find((a) => !isPublicAddress(a.address));
    if (forbidden) {
      throw new UnsafeWebhookTargetError(
        'FORBIDDEN_ADDRESS',
        `Host ${hostname} resolves to a non-public address`,
      );
    }
  }
  return { url, hostname, address: first };
}
