/** AWS region code, e.g. `af-south-1`. */
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** Hostname suffix appended to a region, e.g. `.api.example.com`. */
const ORIGIN_SUFFIX = /^\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isRegionCode(value: unknown): value is string {
  return typeof value === 'string' && REGION.test(value);
}

/**
 * Validates a cell origin and returns it normalised (no trailing slash), or `undefined` when it
 * is unsafe to send clients there: only bare `https://` origins (plain `http://` only when
 * `allowInsecure`, i.e. test/development — never in production, loopback included), no
 * credentials, path, query or fragment.
 */
export function parseOrigin(raw: unknown, allowInsecure: boolean): string | undefined {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const schemeOk = url.protocol === 'https:' || (allowInsecure && url.protocol === 'http:');
  if (!schemeOk || !url.hostname || url.username || url.password) return undefined;
  if (url.pathname !== '/' || url.search || url.hash) return undefined;
  return url.origin;
}

/**
 * Parses `CELL_ORIGINS`: a JSON object mapping region → origin, e.g.
 * `{"af-south-1":"https://af-south-1.api.example.com"}`. Throws a readable message when the
 * value is not such an object or any entry is invalid.
 */
export function parseCellOriginMap(
  raw: string,
  allowInsecure: boolean,
): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CELL_ORIGINS must be a JSON object of region → origin');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CELL_ORIGINS must be a JSON object of region → origin');
  }
  const map: Record<string, string> = {};
  for (const [region, value] of Object.entries(parsed)) {
    const origin = parseOrigin(value, allowInsecure);
    if (!isRegionCode(region) || !origin) {
      throw new Error(`CELL_ORIGINS entry ${JSON.stringify(region)} is not region → origin`);
    }
    map[region] = origin;
  }
  return Object.freeze(map);
}

export function isOriginSuffix(value: string): boolean {
  return ORIGIN_SUFFIX.test(value);
}

/** The configuration subset that decides which cells are trusted. */
export interface CellOriginConfig {
  CELL_REGION: string;
  CELL_API_BASE_URL: string;
  CELL_ORIGINS?: Readonly<Record<string, string>>;
  CELL_ORIGIN_SUFFIX?: string;
}

/**
 * The trusted public origin of the cell serving `region`, from configuration only (never
 * from the directory, a token or a request). `undefined` means "not a cell we know": callers
 * must neither redirect there nor treat the region as a routing hint.
 *
 * Sources, in order: the explicit `CELL_ORIGINS` map; else `https://<region><suffix>` from
 * `CELL_ORIGIN_SUFFIX`; else (development/test only — production requires one of the two)
 * just this cell.
 */
export function trustedCellOrigin(config: CellOriginConfig, region: string): string | undefined {
  if (!isRegionCode(region)) return undefined;
  if (region === config.CELL_REGION) return new URL(config.CELL_API_BASE_URL).origin;
  if (config.CELL_ORIGINS) return config.CELL_ORIGINS[region];
  if (config.CELL_ORIGIN_SUFFIX) return `https://${region}${config.CELL_ORIGIN_SUFFIX}`;
  return undefined;
}
