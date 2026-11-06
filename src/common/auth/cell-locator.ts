/**
 * Port through which the auth layer turns a cell region into that cell's public API base URL
 * (to enrich 421 Misdirected Request responses). Implemented by the tenant directory
 * (`src/modules/directory`); optional, so the guard works without it.
 */
export interface CellLocator {
  /** The validated base URL of the cell serving `region`, if the directory knows it. */
  apiBaseUrlFor(region: string): Promise<string | undefined>;
}

export const CELL_LOCATOR = Symbol('CELL_LOCATOR');
