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

import { ApiError, createClient, type Api } from '../api/api';
import { cellLabel, clientBaseFor, DEFAULT_CELL_BASE } from '../api/cells';
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
  source: 'directory' | 'default';
}

/**
 * Mutable, framework-free holder of the tenant's cell base and the two sessions. The API
 * clients read it on every request; React subscribes to it for re-renders.
 */
export class LenderStore {
  base = DEFAULT_CELL_BASE;
  private sessions: Sessions = { customer: null, staff: null };
  private readonly listeners = new Set<() => void>();
  readonly api: Record<Area, Api>;

  constructor() {
    this.api = {
      customer: this.client('customer'),
      staff: this.client('staff'),
    };
  }

  private client(area: Area): Api {
    return createClient({
      base: () => this.base,
      tokens: {
        get: () => this.sessions[area]?.tokens ?? null,
        set: (tokens) => {
          const me = this.sessions[area]?.me ?? null;
          this.update(area, tokens ? { tokens, me } : null);
        },
      },
    });
  }

  private update(area: Area, session: Session | null): void {
    this.sessions = { ...this.sessions, [area]: session };
    this.listeners.forEach((l) => {
      l();
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = (): Sessions => this.sessions;

  /** Stores the tokens, then asks the API who signed in (`GET /v1/me`). */
  readonly signIn = async (area: Area, tokens: TokenPair): Promise<void> => {
    this.update(area, { tokens, me: null });
    try {
      const me = await this.api[area].whoAmI();
      if (me.kind !== 'USER') throw new Error('A platform admin cannot use a lender site');
      const current = this.sessions[area];
      if (current) this.update(area, { ...current, me });
    } catch (err) {
      this.update(area, null);
      throw err;
    }
  };

  readonly signOut = (area: Area): void => {
    const current = this.sessions[area];
    if (current) void this.api[area].logout(current.tokens.refreshToken).catch(() => undefined);
    this.update(area, null);
  };

  /** Directory lookup (home cell), then the tenant's public branding from that cell. */
  async boot(slug: string): Promise<{ branding: PublicBranding; cell: CellInfo }> {
    let cell: CellInfo = {
      region: cellLabel(DEFAULT_CELL_BASE),
      base: DEFAULT_CELL_BASE,
      source: 'default',
    };
    try {
      const entry = await createClient({ base: () => DEFAULT_CELL_BASE }).directory(slug);
      cell = {
        region: entry.homeRegion,
        base: clientBaseFor(entry.apiBaseUrl),
        source: 'directory',
      };
    } catch {
      // No directory entry: stay on the default cell, which serves the tenant or answers
      // with a 307 to its home cell (followed by the browser, visible in Developer view).
    }
    this.base = cell.base;
    const branding = await this.api.customer.branding(slug);
    return { branding, cell };
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
  | { kind: 'ready'; branding: PublicBranding; theme: ThemeReport; cell: CellInfo };

/** Mount with `key={slug}`: a different lender gets a fresh store and fresh sessions. */
export function LenderProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const [store] = useState(() => new LenderStore());
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const sessions = useSyncExternalStore(store.subscribe, store.snapshot);

  useEffect(() => {
    const run = { cancelled: false };
    store.boot(slug).then(
      ({ branding, cell }) => {
        if (run.cancelled) return;
        setState({ kind: 'ready', branding, theme: applyBranding(branding), cell });
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
  if (state.kind === 'error') {
    return (
      <main className="boot">
        <h1>Cannot load this lender</h1>
        <p>{state.message}</p>
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
    cell: state.cell,
    api: store.api,
    sessions,
    signIn: store.signIn,
    signOut: store.signOut,
  };
  return <LenderContext.Provider value={value}>{children}</LenderContext.Provider>;
}
