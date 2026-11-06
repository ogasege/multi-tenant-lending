/**
 * Money and rate formatting. The API sends amounts as integer strings in ISO 4217 minor units
 * (NGN: 2 decimals, XOF: 0). Arithmetic stays in BigInt; Intl only renders.
 */

/** Minor-unit exponent of a currency according to ICU (NGN 2, XOF 0, JPY 0, …). */
export function currencyExponent(currency: string): number {
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** "125000000" (NGN) → "1250000.00": an exact decimal string, no float rounding. */
export function minorToDecimalString(minor: string, currency: string): string {
  if (!/^-?\d+$/.test(minor)) throw new RangeError(`Not a minor-unit integer: ${minor}`);
  const exp = currencyExponent(currency);
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(exp + 1, '0');
  const int = digits.slice(0, digits.length - exp);
  const frac = exp > 0 ? `.${digits.slice(digits.length - exp)}` : '';
  return `${negative ? '-' : ''}${int}${frac}`;
}

/** Formats minor units for the lender's locale, e.g. ₦1,250,000.00 or 1 250 000 F CFA. */
export function formatMoney(minor: string, currency: string, locale: string): string {
  const exp = currencyExponent(currency);
  const fmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  });
  // Intl.NumberFormat v3 accepts an exact decimal string; no Number() precision loss.
  return fmt.format(minorToDecimalString(minor, currency) as `${number}`);
}

/**
 * Parses what a person typed in the lender's locale into minor units. Accepts the locale's
 * grouping and decimal separators; refuses more decimals than the currency has.
 * Returns null when the text is not a valid non-negative amount.
 */
export function parseMoneyInput(text: string, currency: string, locale: string): string | null {
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
  const group = parts.find((p) => p.type === 'group')?.value ?? ',';
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  let s = text.trim().replace(/[\s\u00a0\u202f]/g, '');
  s = s.split(group).join('');
  if (decimal !== '.') s = s.replace(decimal, '.');
  s = s.replace(/[^\d.]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const exp = currencyExponent(currency);
  const [int = '0', frac = ''] = s.split('.');
  if (frac.length > exp) return null;
  const minor = BigInt(int) * 10n ** BigInt(exp) + BigInt(frac.padEnd(exp, '0') || '0');
  return minor.toString();
}

/** Whole units of a currency in minor units: `majorToMinor(1_250_000, 'NGN')` → "125000000". */
export function majorToMinor(units: number, currency: string): string {
  return (BigInt(units) * 10n ** BigInt(currencyExponent(currency))).toString();
}

/** Basis points as a percentage: 3625 → "36.3%" (en-NG) or "36,3 %" (fr-SN). */
export function formatBps(bps: number, locale: string, digits = 1): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(bps / 10_000);
}

/** ISO date (YYYY-MM-DD) in the locale's medium style, without time-zone drift. */
export function formatDate(iso: string, locale: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/** Local calendar date `days` before `now`, as YYYY-MM-DD (0 = today). */
export function isoDaysAgo(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
