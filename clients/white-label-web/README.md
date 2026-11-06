# White-label credit web client

One build of a React app serves every lender on the 10mg Lending Core. A pharmacy finances a
supplier cart at checkout, the lender pays the supplier, and the pharmacy repays. Lender staff
work a back-office: applications queue, credit decision, approval, disbursement, repayments,
ledger and audit chain.

**No lender-specific code exists in this client.** A lender's look, language and number
formats come from one public call:

```
GET /v1/institutions/{slug}/branding
→ { displayName, primaryColor, secondaryColor, locale, logoUrl, supportEmail, … }
```

## Run it against the local stack

```bash
# repo root: API on :3000 (Lagos cell), plus the EU cell on :3001 for the Dakar lender
make up PROFILES=two-cells
make seed-all                 # registers the 4 demo lenders from demo-brands/lenders.json

cd clients/white-label-web
npm ci
npm run dev                   # http://localhost:5173
```

Open <http://localhost:5173> for the list of demo lenders, or go straight to a lender:

| Lender (fictional)    | Borrower site            | Back-office                    | Cell             |
| --------------------- | ------------------------ | ------------------------------ | ---------------- |
| Eko MediCredit MFB    | `/l/eko-medicredit`      | `/l/eko-medicredit/admin`      | af-south-1 :3000 |
| Arewa PharmaFinance   | `/l/arewa-pharmafinance` | `/l/arewa-pharmafinance/admin` | af-south-1 :3000 |
| Delta CareLend        | `/l/delta-carelend`      | `/l/delta-carelend/admin`      | af-south-1 :3000 |
| Teranga Santé Finance | `/l/teranga-sante`       | `/l/teranga-sante/admin`       | eu-west-3 :3001  |

`/l/:slug` stands in for a lender's own host name (`{slug}.credit.example`) in local runs.

Staff sign in as `credit@{slug}.example` (assess, approve), `finance@{slug}.example`
(disburse, record repayments, ledger, audit), `audit@{slug}.example` or `admin@{slug}.example`
with `SEED_STAFF_PASSWORD` from the repo's `.env`. Staff names and permissions on screen come
from `GET /v1/me`. Pharmacies sign up themselves. On the sign-up page, pick the outcome you want
(**APPROVE**, **COUNTER_OFFER** or **DECLINE**) and press **Fill demo details**: the form is
filled with a demo applicant from `demo-brands/demo-applicants.json`. `make seed` writes that
file after scoring candidate applicants with this database's mock bureau and scorecard, so the
outcome is known in advance for the demo cart (500 000 NGN or 1 000 000 XOF, 30-day supplier
product). Each demo national id registers once per lender. When one is already used (409), the
page fills in the next applicant with the same outcome. When none is left, re-seed a fresh
database (`make clean && make up && make seed-all`).

Sessions are kept **in memory only** (never localStorage). Reloading the page signs you out;
use the in-app links. Use one browser window per role for the demo.

### Demo script (silent video)

1. Pharmacy: `/l/eko-medicredit` → Continue to checkout → pick APPROVE → Fill demo details →
   Create account.
2. Finance this cart: each supplier-paid product is priced live
   (`POST /loan-products/{id}/quote`). The page shows APR, total cost of credit, the amount
   financed (cart plus fee) and what the supplier receives (the full cart). Products above the
   lender's APR cap are disabled. Each cart gets its own order reference (`ORD-…`). The lender
   resolves the supplier to pay from that order, so the client never sends a payee account.
3. Apply → status page (polls every 4 s).
4. Credit officer (second window): queue → application → Run credit assessment (decision,
   grade, reason codes) → Approve. The maker-checker banner explains the next step.
5. Finance officer: Loans → Disburse. Open **Developer view** and press _Resend with the same
   key_: the response carries `Idempotent-Replayed: true` and no second payout happens.
   Then record a repayment: every channel except CASH needs the statement or transfer
   reference, and the value date must be today or up to 3 days back. _Use payoff amount_
   closes the loan. End-of-day (admin, Ledger page) closes the previous business date.
6. Back on the pharmacy window: "Your supplier has been paid", schedule and payoff.
7. Ledger: trial balance **Balanced ✓**. Audit: **Verify chain → Verified ✓**.
8. Repeat at `/l/teranga-sante`: same build, French copy, XOF without decimals, and the
   Developer view shows every call served by the `eu-west-3` cell.

## How a lender's look is derived

`src/session/lender.tsx` boots each lender:

1. `GET /v1/directory/institutions/{slug}` → the tenant's home cell (`apiBaseUrl`); every
   later call goes there. Without a directory entry the default cell is used, which serves the
   tenant or answers 307 to its home cell.
2. `GET /v1/institutions/{slug}/branding` from that cell.
3. `src/theme/branding.ts` turns it into CSS custom properties on `<html>`:

   | Variable                                        | From                                                       |
   | ----------------------------------------------- | ---------------------------------------------------------- |
   | `--brand-primary`                               | `primaryColor`, darkened only if no text colour reaches AA |
   | `--brand-on-primary`                            | white or ink, whichever contrasts more (≥ 4.5:1)           |
   | `--brand-primary-text`                          | primary darkened until it is readable on white (links)     |
   | `--brand-primary-hover`, `--brand-primary-soft` | derived shades                                             |
   | `--brand-secondary`, `--brand-on-secondary`     | `secondaryColor`, same AA rule                             |

   It also sets `lang`, the page title and the copy language (`en`/`fr` from `locale`).

4. Components only use `var(--brand-…)` plus fixed shared tokens (`src/styles.css`). The
   Developer view's _Theme_ tab shows the tokens, the contrast ratios and any AA fallback.

Money arrives as integer strings in minor units of the branding's `defaultCurrency`
(`supportedCurrencies` lists the others). `src/money/format.ts` keeps it in `BigInt`, takes
the exponent from ICU (NGN 2, XOF 0) and renders with `Intl.NumberFormat` in the lender's
locale: `₦500,000.00` (en-NG), `1 000 000 F CFA` (fr-SN). The logo is the presigned
`logoUrl`, loaded directly.

## API client and behaviour shown in the demo

- `src/api/api.ts` is the single typed client (types in `src/api/types.ts`, mirrored from the
  backend DTOs). It adds the bearer token, refreshes once on 401, and turns RFC 9457 problems
  into `ApiError`.
- Money-moving actions (`apply`, `approve`, `disburse`, `record repayment`) use
  `useIdempotentAction`: one `crypto.randomUUID()` key per user action, **reused on retry**
  until the action succeeds.
- Errors are shown as friendly, localised sentences by `code` (`src/i18n/errors.ts`) with the
  raw code, status and trace id in small type.
- **Developer view** (footer toggle): every call with method, path, status, the serving cell
  (`X-Tenant-Cell`, on every response), timing,
  `Idempotency-Key`, `Idempotent-Replayed`, `RateLimit`/`RateLimit-Policy`, `X-Request-ID`,
  redirects, and redacted request/response bodies. Idempotent calls can be resent verbatim.
- **Cell allow-list.** The client only talks to cells listed at build time in
  `VITE_CELL_ORIGINS`, a JSON map region → origin (default: the local two-cell stack,
  `{"af-south-1":"http://localhost:3000","eu-west-3":"http://localhost:3001"}`). Every origin
  must be `https://`; `http://localhost` / `http://127.0.0.1` are accepted in dev builds only,
  so a production build needs its own `VITE_CELL_ORIGINS` or it refuses to start. The
  directory's `apiBaseUrl` can only select one of these cells: any other value is refused,
  requests stay on the default cell (`VITE_DEFAULT_CELL`, else the first entry) and Developer
  view shows the error. This keeps a poisoned directory entry from receiving credentials.
- **Redirects are never followed by the browser.** Every call uses `redirect: 'manual'`.
  A cell answers 307 for a tenant homed elsewhere; the client resends that request **once**
  (same method, body and `Idempotency-Key`) only to an allow-listed cell, else it stops with
  `CELL_ROUTING_REFUSED` and Developer view shows "Cell routing refused". Browsers return an
  opaque redirect (status 0, no `Location`, headers or body) for `manual` fetches, so in the
  browser the home cell comes from a fresh directory lookup on the default cell, checked
  against the allow-list. Where the 307 is readable (tests, non-browser runtimes) the
  `Location` origin decides, then `X-Tenant-Cell` / the problem body's `homeRegion`. A
  foreign `Location` is refused outright, and a second redirect is never followed.
- The Vite dev server proxies each allow-listed cell under `/cell/{region}` (same origin, no
  CORS preflight); dev builds call those prefixes, production builds the origins directly
  (override with `VITE_CELL_PROXY=true|false`). The API exposes the headers above via CORS.

## Demo brands

`demo-brands/lenders.json` lists the four fictional lenders (slug, legal name, colours,
locale, currency, lender type, APR cap, home region, logo). All names and logos are original.
The backend seed (`src/cli/seed-lenders.ts`) reads it, uploads each PNG logo through the
presigned POST and sets the branding. Logos are authored as SVG in `demo-brands/logos/` and
rendered to PNG with `npm run logos` (the API refuses SVG uploads). Every palette passes WCAG
AA for text on primary and secondary; `src/theme/contrast.test.ts` checks it.

| Lender                | Primary   | Secondary | Text on primary |
| --------------------- | --------- | --------- | --------------- |
| Eko MediCredit        | `#0B6E4F` | `#F2A541` | white, 6.3:1    |
| Arewa PharmaFinance   | `#5B2A86` | `#D4A017` | white, 9.9:1    |
| Delta CareLend        | `#0E4C92` | `#0B7A75` | white, 8.5:1    |
| Teranga Santé Finance | `#A63D24` | `#1D4E89` | white, 6.3:1    |

## Quality

```bash
npm run lint      # eslint (strict type-checked) + prettier --check + tsc
npm run build
npm test          # Vitest + Testing Library: theming, money, contrast, errors, client, hooks
npm run e2e       # Playwright: pharmacy journey against the local stack
npm run screenshots   # captures screenshots/ for all four lenders
```

The Playwright tests need the stack (`make up PROFILES=two-cells && make seed-all`); they skip
themselves when the API is not reachable. Staff steps use `SEED_STAFF_PASSWORD` from the
environment or, failing that, from the repo's `.env` (the value `make seed` used); without it
the journey stops after the application is submitted.
