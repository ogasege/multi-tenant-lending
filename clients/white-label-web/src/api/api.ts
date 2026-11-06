/**
 * The one typed client for the 10mg Lending Core API. Every network call of the app goes
 * through `request`, which:
 *  - targets the tenant's home cell (base resolved from the directory),
 *  - adds `Authorization` from the in-memory session and refreshes once on 401,
 *  - sends `Idempotency-Key` when the caller passes one (the caller owns key reuse),
 *  - turns RFC 9457 problem responses into `ApiError`,
 *  - records the exchange for the Developer view.
 */
import { cellLabel } from './cells';
import { devLog, redact, SHOWN_HEADERS } from './devlog';
import type {
  Application,
  ApplicationDetail,
  ApplicationStatus,
  Approval,
  Assessment,
  AuditLogEntry,
  ChainVerification,
  Customer,
  CustomerRegistration,
  EndOfDaySummary,
  DirectoryEntry,
  Loan,
  LoanLedger,
  Me,
  LoanProduct,
  Page,
  PayoffQuote,
  Problem,
  PublicBranding,
  Quote,
  RecordRepaymentRequest,
  RegisterCustomerRequest,
  Repayment,
  RepaymentResult,
  Schedule,
  SubmitApplicationRequest,
  TokenPair,
  TrialBalance,
} from './types';

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title ?? `HTTP ${problem.status}`);
    this.name = 'ApiError';
  }

  get code(): string {
    return this.problem.code ?? `HTTP_${this.problem.status}`;
  }
}

export interface TokenStore {
  get(): TokenPair | null;
  set(tokens: TokenPair | null): void;
}

export interface ClientOptions {
  /** Base of the tenant's cell, e.g. `/cell/af-south-1` or `https://af-south-1.api…`. */
  base: () => string;
  tokens?: TokenStore;
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  auth?: boolean;
}

function toQuery(query: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toProblem(status: number, body: unknown): Problem {
  if (body !== null && typeof body === 'object' && 'status' in body) return body as Problem;
  return { status, title: typeof body === 'string' ? body.slice(0, 200) : `HTTP ${status}` };
}

export function createClient(opts: ClientOptions) {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  let refreshing: Promise<boolean> | null = null;

  async function send<T>(
    method: string,
    path: string,
    o: RequestOptions,
    retried: boolean,
  ): Promise<T> {
    const base = opts.base();
    const url = `${base}${path}${toQuery(o.query)}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
    const tokens = o.auth === false ? null : (opts.tokens?.get() ?? null);
    if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;

    const started = performance.now();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      });
    } catch (err) {
      const problem: Problem = {
        status: 0,
        code: 'NETWORK_ERROR',
        detail: err instanceof Error ? err.message : String(err),
      };
      record(method, path, url, base, 0, started, o, problem, new Headers(), null);
      throw new ApiError(problem);
    }
    const body = await readBody(res);
    const redirectedTo = res.redirected ? res.url : null;
    record(method, path, url, base, res.status, started, o, body, res.headers, redirectedTo, () =>
      send(method, path, o, true),
    );

    if (res.ok) return body as T;
    const problem = toProblem(res.status, body);
    if (res.status === 401 && !retried && o.auth !== false && tokens && (await refresh())) {
      return send<T>(method, path, o, true);
    }
    throw new ApiError(problem);
  }

  function record(
    method: string,
    path: string,
    url: string,
    base: string,
    status: number,
    started: number,
    o: RequestOptions,
    responseBody: unknown,
    headers: Headers,
    redirectedTo: string | null,
    replay?: () => Promise<unknown>,
  ): void {
    const responseHeaders: Record<string, string> = {};
    for (const name of SHOWN_HEADERS) {
      const v = headers.get(name);
      if (v !== null) responseHeaders[name] = v;
    }
    devLog.add({
      at: new Date().toISOString(),
      method,
      path,
      url,
      // The serving cell names itself in X-Tenant-Cell on every response.
      cell:
        headers.get('x-tenant-cell') ??
        (redirectedTo ? cellLabel(new URL(redirectedTo).origin) : cellLabel(base)),
      status,
      durationMs: Math.round(performance.now() - started),
      idempotencyKey: o.idempotencyKey ?? null,
      requestBody: redact(o.body),
      responseBody: redact(responseBody),
      responseHeaders,
      redirectedTo,
      replay: o.idempotencyKey && replay ? replay : null,
    });
  }

  /** Rotates the refresh token once; concurrent 401s share the same refresh. */
  function refresh(): Promise<boolean> {
    const current = opts.tokens?.get();
    if (!current) return Promise.resolve(false);
    refreshing ??= send<TokenPair>(
      'POST',
      '/v1/auth/refresh',
      { body: { refreshToken: current.refreshToken }, auth: false },
      true,
    )
      .then((pair) => {
        opts.tokens?.set(pair);
        return true;
      })
      .catch(() => {
        opts.tokens?.set(null);
        return false;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  const get = <T>(path: string, query?: RequestOptions['query'], auth = true) =>
    send<T>('GET', path, { query, auth }, false);
  const post = <T>(path: string, body?: unknown, idempotencyKey?: string, auth = true) =>
    send<T>('POST', path, { body: body ?? {}, idempotencyKey, auth }, false);
  const id = encodeURIComponent;

  return {
    // Public
    directory: (slug: string) =>
      get<DirectoryEntry>(`/v1/directory/institutions/${id(slug)}`, undefined, false),
    branding: (slug: string) =>
      get<PublicBranding>(`/v1/institutions/${id(slug)}/branding`, undefined, false),
    login: (institutionSlug: string, email: string, password: string) =>
      post<TokenPair>('/v1/auth/login', { institutionSlug, email, password }, undefined, false),
    logout: (refreshToken: string) =>
      post<null>('/v1/auth/logout', { refreshToken }, undefined, false),
    register: (slug: string, body: RegisterCustomerRequest) =>
      post<CustomerRegistration>(
        `/v1/institutions/${id(slug)}/customers/register`,
        body,
        undefined,
        false,
      ),

    // Customer + staff
    whoAmI: () => get<Me>('/v1/me'),
    me: () => get<Customer>('/v1/customers/me'),
    customer: (customerId: string) => get<Customer>(`/v1/customers/${id(customerId)}`),
    products: () => get<Page<LoanProduct>>('/v1/loan-products', { status: 'ACTIVE', limit: 50 }),
    quote: (productId: string, principal: string, term: number) =>
      post<Quote>(`/v1/loan-products/${id(productId)}/quote`, { principal, term }),
    submitApplication: (body: SubmitApplicationRequest, key: string) =>
      post<Application>('/v1/loan-applications', body, key),
    applications: (query: { status?: ApplicationStatus; cursor?: string; limit?: number } = {}) =>
      get<Page<Application>>('/v1/loan-applications', query),
    application: (appId: string) => get<ApplicationDetail>(`/v1/loan-applications/${id(appId)}`),
    withdraw: (appId: string) => post<Application>(`/v1/loan-applications/${id(appId)}/withdraw`),
    loans: (query: { status?: string; cursor?: string; limit?: number } = {}) =>
      get<Page<Loan>>('/v1/loans', query),
    loan: (loanId: string) => get<Loan>(`/v1/loans/${id(loanId)}`),
    schedule: (loanId: string) => get<Schedule>(`/v1/loans/${id(loanId)}/schedule`),
    payoff: (loanId: string) => get<PayoffQuote>(`/v1/loans/${id(loanId)}/payoff-quote`),
    repayments: (loanId: string) =>
      get<{ items: Repayment[] }>(`/v1/loans/${id(loanId)}/repayments`),

    // Staff
    assess: (appId: string) => post<Assessment>(`/v1/loan-applications/${id(appId)}/assess`),
    approve: (appId: string, body: { approvedPrincipal?: string; notes?: string }, key: string) =>
      post<Approval>(`/v1/loan-applications/${id(appId)}/approve`, body, key),
    reject: (appId: string, body: { reasonCodes: string[]; notes?: string }) =>
      post<Application>(`/v1/loan-applications/${id(appId)}/reject`, body),
    disburse: (loanId: string, key: string) =>
      post<Loan>(`/v1/loans/${id(loanId)}/disburse`, {}, key),
    recordRepayment: (loanId: string, body: RecordRepaymentRequest, key: string) =>
      post<RepaymentResult>(`/v1/loans/${id(loanId)}/repayments`, body, key),
    loanLedger: (loanId: string) => get<LoanLedger>(`/v1/loans/${id(loanId)}/ledger`),
    trialBalance: (currency?: string) =>
      get<TrialBalance>('/v1/ledger/trial-balance', { currency }),
    auditLogs: (query: { cursor?: string; limit?: number } = {}) =>
      get<Page<AuditLogEntry>>('/v1/audit-logs', query),
    verifyAudit: () => get<ChainVerification>('/v1/audit-logs/verify'),
    endOfDay: (asOf: string) => post<EndOfDaySummary>('/v1/operations/end-of-day', { asOf }),
  };
}

export type Api = ReturnType<typeof createClient>;
