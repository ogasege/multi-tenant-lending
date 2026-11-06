/**
 * Per-lender runtime: resolves the tenant's home cell, loads its public branding, applies the
 * theme and holds the in-memory sessions (one for the pharmacy side, one for staff). Tokens
 * never touch localStorage: a reload signs everyone out, by design.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import {
  ApiError,
  createClient,
  type Api,
  type RedirectDecision,
  type RedirectHint,
} from '../api/api';
import {
  resolveLocation,
  resolveRegion,
  type CellConfig,
  type CellResolution,
} from '../api/cellConfig';
import { CELL_CONFIG, defaultCell, resolveCell } from '../api/cells';
import type { Me, PublicBranding, TokenPair } from '../api/types';
import { messagesFor, type Messages } from '../i18n/messages';
import { applyBranding, type ThemeReport } from '../theme/branding';

export type Area = 'customer' | 'staff';

export interface Session {
  tokens: TokenPair;
  /** From `GET /v1/me`; null for the instant between sign-in and that response. */
  me: Extract<Me, { kind: 'USER' }> | null;
}

type Sessions = Readonly<Record<Area, Session | null>>;

export interface CellInfo {
  region: string;
  base: string;
  /**
   * `rejected`: the directory named a host outside the allow-list; the default cell is used.
   * `redirect`: a cell answered 307 and the client moved to the allow-listed home cell.
   */
  source: 'directory' | 'default' | 'rejected' | 'redirect';
  /** Cell-routing problems (rejected directory entry or configuration), for Developer view. */
  errors: readonly string[];
}

export interface LenderSnapshot {
  sessions: Sessions;
  /** Null until `boot` has picked a cell. */
  cell: CellInfo | null;
}

/**
 * Mutable, framework-free holder of the tenant's cell and the two sessions. The API clients
 * read it on every request; React subscribes to it for re-renders.
 */
export class LenderStore {
  private slug = '';
  private state: LenderSnapshot = { sessions: { customer: null, staff: null }, cell: null };
  private readonly listeners = new Set<() => void>();
  readonly api: Record<Area, Api>;

  constructor(private readonly cells: CellConfig = CELL_CONFIG) {
    this.api = {
      customer: this.client('customer'),
      staff: this.client('staff'),
    };
  }

  /** Empty until `boot` picks an allow-listed cell: no request can leave before that. */
  get base(): string {
    return this.state.cell?.base ?? '';
  }

  private client(area: Area): Api {
    return createClient({
      base: () => this.base,
      redirects: this.followRedirect,
      tokens: {
        get: () => this.state.sessions[area]?.tokens ?? null,
        set: (tokens) => {
          const me = this.state.sessions[area]?.me ?? null;
          this.update(area, tokens ? { tokens, me } : null);
        },
      },
    });
  }

  private set(next: Partial<LenderSnapshot>): void {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => {
      l();
    });
  }

  private update(area: Area, session: Session | null): void {
    this.set({ sessions: { ...this.state.sessions, [area]: session } });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): LenderSnapshot => this.state;

  /** Stores the tokens, then asks the API who signed in (`GET /v1/me`). */
  readonly signIn = async (area: Area, tokens: TokenPair): Promise<void> => {
    this.update(area, { tokens, me: null });
    try {
      const me = await this.api[area].whoAmI();
      if (me.kind !== 'USER') throw new Error('A platform admin cannot use a lender site');
      const current = this.state.sessions[area];
      if (current) this.update(area, { ...current, me });
    } catch (err) {
      this.update(area, null);
      throw err;
    }
  };

  readonly signOut = (area: Area): void => {
    const current = this.state.sessions[area];
    if (current) void this.api[area].logout(current.tokens.refreshToken).catch(() => undefined);
    this.update(area, null);
  };

  /** Directory lookup on the default cell; never follows a redirect itself. */
  private async lookUpHomeCell(): Promise<CellResolution | null> {
    const fallback = defaultCell(this.cells);
    try {
      const entry = await createClient({ base: () => fallback.base }).directory(this.slug);
      return resolveCell(entry.apiBaseUrl, this.cells);
    } catch {
      return null;
    }
  }

  /**
   * Redirect policy of both API clients (SPEC §4.1: a cell answers 307 for a tenant homed
   * elsewhere). A readable redirect is followed only to an allow-listed origin (Location, else
   * `X-Tenant-Cell` / `homeRegion`). Browsers hide redirects from `redirect: 'manual'`
   * fetches (opaque response, no Location or headers), so the home cell then comes from a
   * fresh directory lookup, again checked against the allow-list.
   */
  private readonly followRedirect = async (hint: RedirectHint): Promise<RedirectDecision> => {
    const current = this.state.cell;
    let target: CellResolution;
    if (hint.location !== null) target = resolveLocation(hint.location, this.cells);
    else if (hint.region !== null) target = resolveRegion(hint.region, this.cells);
    else
      target = (await this.lookUpHomeCell()) ?? {
        ok: false,
        reason: 'A cell redirected, and the directory could not name the home cell',
      };
    if (target.ok && target.base === current?.base) {
      target = { ok: false, reason: `Cell ${target.region} redirected to itself` };
    }
    if (!current) return { refused: target.ok ? 'No cell selected yet' : target.reason };
    if (!target.ok) {
      this.set({ cell: { ...current, errors: [...current.errors, target.reason] } });
      return { refused: target.reason };
    }
    this.set({
      cell: { ...current, region: target.region, base: target.base, source: 'redirect' },
    });
    return { base: target.base };
  };

  /** Directory lookup (home cell), then the tenant's public branding from that cell. */
  async boot(slug: string): Promise<{ branding: PublicBranding }> {
    this.slug = slug;
    const fallback = defaultCell(this.cells);
    let cell: CellInfo = { ...fallback, source: 'default', errors: this.cells.errors };
    const resolved = await this.lookUpHomeCell();
    if (resolved?.ok) {
      cell = { ...cell, region: resolved.region, base: resolved.base, source: 'directory' };
    } else if (resolved) {
      // Never follow a directory entry to an unknown host: credentials would go with it.
      // The refusal is shown in Developer view.
      cell = { ...cell, source: 'rejected', errors: [...cell.errors, resolved.reason] };
    }
    // No directory entry: stay on the default cell, which serves the tenant or answers with
    // a 307 that `followRedirect` checks (visible in Developer view).
    this.set({ cell });
    const branding = await this.api.customer.branding(slug);
    return { branding };
  }
}

export interface LenderValue {
  slug: string;
  branding: PublicBranding;
  theme: ThemeReport;
  locale: string;
  /** The lender's reporting currency, from branding `defaultCurrency`. */
  currency: string;
  t: Messages;
  cell: CellInfo;
  api: Record<Area, Api>;
  sessions: Sessions;
  signIn: (area: Area, tokens: TokenPair) => Promise<void>;
  signOut: (area: Area) => void;
}

const LenderContext = createContext<LenderValue | null>(null);

export function useLender(): LenderValue {
  const value = useContext(LenderContext);
  if (!value) throw new Error('useLender must be used inside <LenderProvider>');
  return value;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; branding: PublicBranding; theme: ThemeReport };

/** Mount with `key={slug}`: a different lender gets a fresh store and fresh sessions. */
export function LenderProvider({
  slug,
  cells,
  children,
}: {
  slug: string;
  /** Cell allow-list; defaults to the build's `VITE_CELL_ORIGINS` (overridden in tests). */
  cells?: CellConfig;
  children: ReactNode;
}) {
  const [store] = useState(() => new LenderStore(cells));
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const { sessions, cell } = useSyncExternalStore(store.subscribe, store.snapshot);

  useEffect(() => {
    const run = { cancelled: false };
    store.boot(slug).then(
      ({ branding }) => {
        if (run.cancelled) return;
        setState({ kind: 'ready', branding, theme: applyBranding(branding) });
      },
      (err: unknown) => {
        if (run.cancelled) return;
        if (err instanceof ApiError && err.problem.status === 404) setState({ kind: 'missing' });
        else setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      run.cancelled = true;
    };
  }, [slug, store]);

  if (state.kind === 'loading') {
    return (
      <div className="boot" role="status" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        <span className="sr-only">Loading lender…</span>
      </div>
    );
  }
  if (state.kind === 'missing') {
    return (
      <main className="boot">
        <h1>Lender not found</h1>
        <p>
          No active lender uses the address <code>/l/{slug}</code>.
        </p>
      </main>
    );
  }
  if (state.kind === 'error' || !cell) {
    const message = state.kind === 'error' ? state.message : 'No API cell selected';
    return (
      <main className="boot">
        <h1>Cannot load this lender</h1>
        <p>{message}</p>
      </main>
    );
  }

  const locale = state.branding.locale;
  const value: LenderValue = {
    slug,
    branding: state.branding,
    theme: state.theme,
    locale,
    currency: state.branding.defaultCurrency,
    t: messagesFor(locale),
    cell,
    api: store.api,
    sessions,
    signIn: store.signIn,
    signOut: store.signOut,
  };
  return <LenderContext.Provider value={value}>{children}</LenderContext.Provider>;
}
