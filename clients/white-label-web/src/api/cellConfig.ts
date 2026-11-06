/**
 * The build-time allow-list of API cells (SPEC §4.1). Framework-free so that both the client
 * (src/api/cells.ts) and the dev-server proxy (vite.config.ts) read the same list.
 *
 * `VITE_CELL_ORIGINS` is a JSON object, region → origin, e.g.
 * `{"af-south-1":"https://af-south-1.api.example.com","eu-west-3":"https://eu-west-3.api.example.com"}`.
 * Every origin must be https://, except http://localhost and http://127.0.0.1 in dev builds.
 * The directory may only *select* one of these cells; it can never introduce a new host.
 */

/** The local two-cell stack (docker-compose `PROFILES=two-cells`). */
export const LOCAL_CELL_ORIGINS: Readonly<Record<string, string>> = {
  'af-south-1': 'http://localhost:3000',
  'eu-west-3': 'http://localhost:3001',
};

const REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

export interface CellOptions {
  /** Production build: only https:// origins are accepted. */
  production: boolean;
  /** Call `/cell/{region}` on the page's own origin (dev-server or reverse proxy). */
  proxy: boolean;
  /** Region used when the directory gives nothing usable; defaults to the first entry. */
  defaultRegion?: string | undefined;
}

export interface CellConfig {
  /** Allow-listed cells, region → origin (normalised, no trailing slash). */
  readonly origins: Readonly<Record<string, string>>;
  readonly proxy: boolean;
  /** Null when no valid cell is configured: the client then refuses to start. */
  readonly defaultRegion: string | null;
  /** Problems with the configuration itself (rejected entries), shown in Developer view. */
  readonly errors: readonly string[];
}

/** Why `origin` may not be allow-listed, or null when it is acceptable. */
export function originProblem(origin: string, production: boolean): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return 'not a URL';
  }
  if (url.origin !== origin.replace(/\/$/, ''))
    return 'must be a bare origin (no path or credentials)';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) {
    return production ? 'http:// is not allowed in a production build' : null;
  }
  return 'must use https://';
}

/** Parses and validates `VITE_CELL_ORIGINS`; invalid entries are dropped and reported. */
export function parseCellOrigins(raw: string | undefined, opts: CellOptions): CellConfig {
  const errors: string[] = [];
  let candidates: Record<string, unknown> = { ...LOCAL_CELL_ORIGINS };
  if (raw !== undefined && raw.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      candidates = parsed as Record<string, unknown>;
    } catch {
      errors.push('VITE_CELL_ORIGINS is not a JSON object of region → origin');
      candidates = {};
    }
  }

  const origins: Record<string, string> = {};
  for (const [region, value] of Object.entries(candidates)) {
    if (!REGION.test(region)) {
      errors.push(`Cell "${region}" rejected: invalid region name`);
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`Cell ${region} rejected: origin must be a string`);
      continue;
    }
    const problem = originProblem(value, opts.production);
    if (problem) {
      errors.push(`Cell ${region} (${value}) rejected: ${problem}`);
      continue;
    }
    origins[region] = new URL(value).origin;
  }

  let defaultRegion: string | null = Object.keys(origins)[0] ?? null;
  if (opts.defaultRegion) {
    if (Object.hasOwn(origins, opts.defaultRegion)) defaultRegion = opts.defaultRegion;
    else errors.push(`Default cell ${opts.defaultRegion} is not in the allow-list`);
  }
  if (defaultRegion === null) errors.push('No valid API cell is configured');
  return { origins, proxy: opts.proxy, defaultRegion, errors };
}

/** The base the browser calls for an allow-listed region. */
export function baseForRegion(config: CellConfig, region: string): string {
  const origin = config.origins[region];
  if (origin === undefined) throw new Error(`Cell ${region} is not allow-listed`);
  return config.proxy ? `/cell/${region}` : origin;
}

export type CellResolution =
  { ok: true; region: string; base: string } | { ok: false; reason: string };

/**
 * Maps an `apiBaseUrl` announced by the directory to an allow-listed cell. Anything else is
 * refused: the directory response is data, not configuration, and must never steer
 * credentials to a host the build does not know.
 */
export function resolveCell(apiBaseUrl: string, config: CellConfig): CellResolution {
  const announced = apiBaseUrl.replace(/\/$/, '');
  const region = Object.keys(config.origins).find((r) => config.origins[r] === announced);
  if (region === undefined) {
    return {
      ok: false,
      reason: `Directory named ${apiBaseUrl}, which is not an allow-listed cell`,
    };
  }
  return { ok: true, region, base: baseForRegion(config, region) };
}

/**
 * Maps a redirect `Location` to an allow-listed cell by its origin. A relative or foreign
 * Location is refused: only the build's own cells may receive a resent request.
 */
export function resolveLocation(location: string, config: CellConfig): CellResolution {
  let origin: string;
  try {
    origin = new URL(location).origin;
  } catch {
    return { ok: false, reason: `Redirect to ${location}, which is not an absolute URL` };
  }
  const region = Object.keys(config.origins).find((r) => config.origins[r] === origin);
  if (region === undefined) {
    return { ok: false, reason: `Redirect to ${origin}, which is not an allow-listed cell` };
  }
  return { ok: true, region, base: baseForRegion(config, region) };
}

/** Maps a region named by the API (`X-Tenant-Cell`, `homeRegion`) to an allow-listed cell. */
export function resolveRegion(region: string, config: CellConfig): CellResolution {
  if (!Object.hasOwn(config.origins, region)) {
    return { ok: false, reason: `Redirect to region ${region}, which is not an allow-listed cell` };
  }
  return { ok: true, region, base: baseForRegion(config, region) };
}
