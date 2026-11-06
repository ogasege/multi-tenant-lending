import { type DirectoryEntry, parseApiBaseUrl } from './directory-entry';

export interface RoutingInput {
  /** Slug the request addresses, or `undefined` when it carries none (or a malformed one). */
  slug: string | undefined;
  /** Whether the slug names an institution stored in this cell's database. */
  isLocal: boolean;
  /** Directory entry for the slug, if any (only consulted when not local). */
  entry: DirectoryEntry | undefined;
  /** This cell's region. */
  cellRegion: string;
  /** Request path + query, e.g. `/v1/auth/login`. */
  originalUrl: string;
  /** Accept `http://` base URLs (test/development only). */
  allowInsecure: boolean;
  /**
   * The configured (trusted) origin of a region's cell, or `undefined` for a region that is
   * not a known cell. A redirect is only issued to exactly this origin.
   */
  trustedOrigin: (region: string) => string | undefined;
}

export type RoutingDecision =
  | { action: 'pass' }
  | { action: 'redirect'; location: string; homeRegion: string; apiBaseUrl: string };

const PASS: RoutingDecision = { action: 'pass' };

/**
 * Decides whether a slug-addressed request is served here or redirected to its home cell.
 *
 * Only a tenant that is NOT local, IS in the directory, lives in ANOTHER region and has a
 * valid base URL is redirected. Every other case passes through to the normal handler, so an
 * unknown slug gets exactly the response it got before cells existed (no enumeration
 * oracle), and a directory row pointing at this cell (stale, or replication lag) never
 * causes a redirect loop. The directory's base URL must equal the configured origin of the
 * home region (`CELL_ORIGINS`), so a poisoned directory row can never send clients elsewhere.
 */
export function decideRouting(input: RoutingInput): RoutingDecision {
  if (!input.slug || input.isLocal || !input.entry) return PASS;
  if (input.entry.slug !== input.slug) return PASS;
  if (input.entry.homeRegion === input.cellRegion) return PASS;
  const apiBaseUrl = parseApiBaseUrl(input.entry.apiBaseUrl, input.allowInsecure);
  if (!apiBaseUrl || !input.originalUrl.startsWith('/')) return PASS;
  if (apiBaseUrl !== input.trustedOrigin(input.entry.homeRegion)) return PASS;
  return {
    action: 'redirect',
    location: apiBaseUrl + input.originalUrl,
    homeRegion: input.entry.homeRegion,
    apiBaseUrl,
  };
}
