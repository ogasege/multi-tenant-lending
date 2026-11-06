/**
 * Where to send a tenant's requests. Each institution lives in one regional cell (SPEC §4.1);
 * `GET /v1/directory/institutions/{slug}` names its `apiBaseUrl`, which must match one of the
 * build-time allow-listed cells (`VITE_CELL_ORIGINS`, see ./cellConfig.ts). In development
 * the Vite dev server proxies each cell under `/cell/{region}` (see vite.config.ts).
 */
import { baseForRegion, parseCellOrigins, resolveCell, type CellConfig } from './cellConfig';

export const CELL_CONFIG: CellConfig = parseCellOrigins(
  import.meta.env.VITE_CELL_ORIGINS as string | undefined,
  {
    production: import.meta.env.PROD,
    proxy:
      ((import.meta.env.VITE_CELL_PROXY as string | undefined) ?? String(import.meta.env.DEV)) ===
      'true',
    defaultRegion: import.meta.env.VITE_DEFAULT_CELL as string | undefined,
  },
);

export interface DefaultCell {
  region: string;
  base: string;
}

/** The cell used before (or instead of) the directory; throws if none is configured. */
export function defaultCell(config: CellConfig = CELL_CONFIG): DefaultCell {
  if (config.defaultRegion === null) {
    throw new Error(`No API cell is configured: ${config.errors.join('; ')}`);
  }
  return { region: config.defaultRegion, base: baseForRegion(config, config.defaultRegion) };
}

export { resolveCell };

/** Human label for a base, e.g. `/cell/eu-west-3` → `eu-west-3`. */
export function cellLabel(base: string, config: CellConfig = CELL_CONFIG): string {
  const m = /\/cell\/([a-z0-9-]+)/.exec(base);
  if (m?.[1]) return m[1];
  const origin = base.replace(/\/$/, '');
  return Object.keys(config.origins).find((r) => config.origins[r] === origin) ?? base;
}
