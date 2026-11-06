import type { LookupAddress, LookupOneOptions, LookupAllOptions } from 'node:dns';
import { request } from 'node:https';
import type { LookupFunction } from 'node:net';
import { rootCertificates } from 'node:tls';

import type { SafeTarget } from './safe-target-resolver';

export interface WebhookRequest {
  target: SafeTarget;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Extra trusted CA certificates (tests only); system roots are always trusted. */
  ca?: string | readonly string[];
}

export interface WebhookResponse {
  status: number;
  durationMs: number;
}

/** Response bodies are read only to free the socket; never stored, never more than this. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * POSTs a signed webhook over HTTPS to the address that passed the SSRF check, never to a
 * fresh DNS answer (DNS-rebinding safe): a custom `lookup` returns the pinned IP while the URL
 * hostname still drives the Host header, SNI and certificate verification. One connection per
 * delivery (`agent: false`), so a pooled socket is never reused for another resolution.
 * Redirects are not followed (a 3xx is a failed delivery). Resolves with the status for any
 * HTTP response and rejects on network/TLS errors and on the overall timeout.
 */
export function sendWebhook(req: WebhookRequest): Promise<WebhookResponse> {
  const started = performance.now();
  const { target } = req;
  const pinned = target.address;
  const lookup = ((
    _hostname: string,
    options: LookupOneOptions | LookupAllOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    if ('all' in options && options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  }) as LookupFunction;

  return new Promise<WebhookResponse>((resolve, reject) => {
    const signal = AbortSignal.timeout(req.timeoutMs);
    const httpReq = request(
      {
        protocol: 'https:',
        hostname: target.hostname,
        port: target.url.port || 443,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        servername: isIpLiteral(target.hostname) ? undefined : target.hostname,
        lookup,
        agent: false,
        signal,
        rejectUnauthorized: true,
        // Setting `ca` replaces the default trust store, so the bundled roots are kept too.
        ca: req.ca ? [...toArray(req.ca), ...rootCertificates] : undefined,
        headers: {
          ...req.headers,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(req.body)),
          'user-agent': '10mg-webhooks/1.0',
        },
      },
      (res) => {
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) res.destroy();
        });
        const done = () => {
          resolve({
            status: res.statusCode ?? 0,
            durationMs: Math.round(performance.now() - started),
          });
        };
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    httpReq.on('error', (err) => {
      reject(signal.aborted ? new Error(`Timed out after ${req.timeoutMs} ms`) : err);
    });
    httpReq.end(req.body);
  });
}

function isIpLiteral(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(':');
}

function toArray(ca: string | readonly string[]): readonly string[] {
  return typeof ca === 'string' ? [ca] : ca;
}
