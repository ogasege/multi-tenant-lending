/**
 * Where to send a tenant's requests. Each institution lives in one regional cell (SPEC §4.1);
 * `GET /v1/directory/institutions/{slug}` names its `apiBaseUrl`. In local development the
 * Vite dev server proxies each cell under a same-origin prefix (see vite.config.ts), so the
 * real base URLs are translated to those prefixes here.
 */

export const DEFAULT_CELL_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? '/cell/af-south-1';

/** `VITE_CELL_MAP="http://localhost:3000=/cell/af-south-1,http://localhost:3001=/cell/eu-west-3"`. */
export function parseCellMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [from, to] = pair.split('=').map((s) => s.trim());
    if (from && to) map[from.replace(/\/$/, '')] = to;
  }
  return map;
}

const CELL_MAP: Record<string, string> = {
  'http://localhost:3000': '/cell/af-south-1',
  'http://localhost:3001': '/cell/eu-west-3',
  ...parseCellMap(import.meta.env.VITE_CELL_MAP as string | undefined),
};

/** The base the browser should call for an API base URL announced by the directory. */
export function clientBaseFor(apiBaseUrl: string, map: Record<string, string> = CELL_MAP): string {
  const key = apiBaseUrl.replace(/\/$/, '');
  return map[key] ?? key;
}

/** Human label for a base, e.g. `/cell/eu-west-3` → `eu-west-3`. */
export function cellLabel(base: string): string {
  const m = /\/cell\/([a-z0-9-]+)/.exec(base);
  return m?.[1] ?? base;
}
