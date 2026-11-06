/** Small presentational building blocks. They only use shared and `--brand-*` tokens. */
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';

import type { FriendlyError } from '../i18n/errors';
import { formatBps, formatMoney } from '../money/format';
import { useLender } from '../session/lender';

export function Money({
  minor,
  currency,
}: {
  minor: string | null | undefined;
  currency?: string;
}) {
  const lender = useLender();
  if (minor === null || minor === undefined) return <span>—</span>;
  return (
    <span className="num">{formatMoney(minor, currency ?? lender.currency, lender.locale)}</span>
  );
}

export function Rate({ bps }: { bps: number | null | undefined }) {
  const { locale } = useLender();
  if (bps === null || bps === undefined) return <span>—</span>;
  return <span className="num">{formatBps(bps, locale)}</span>;
}

const BADGE_TONE: Record<string, string> = {
  SUBMITTED: 'info',
  ASSESSED: 'warn',
  APPROVED: 'ok',
  ACTIVE: 'ok',
  CLOSED: 'neutral',
  PAID: 'ok',
  REJECTED: 'danger',
  DECLINE: 'danger',
  WITHDRAWN: 'neutral',
  EXPIRED: 'neutral',
  CANCELLED: 'neutral',
  PENDING_DISBURSEMENT: 'warn',
  APPROVE: 'ok',
  REFER: 'warn',
  COUNTER_OFFER: 'info',
  PENDING: 'neutral',
  PARTIALLY_PAID: 'warn',
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge badge-${BADGE_TONE[value] ?? 'neutral'}`}>{label ?? value}</span>;
}

export function ErrorNote({ error }: { error: FriendlyError | null }) {
  if (!error) return null;
  return (
    <div className="alert alert-danger" role="alert">
      <strong>{error.message}</strong>
      {error.fields.length > 0 && (
        <ul>
          {error.fields.map((f) => (
            <li key={`${f.field}:${f.message}`}>
              <code>{f.field}</code> {f.message}
            </li>
          ))}
        </ul>
      )}
      <code className="alert-code">
        {error.code}
        {error.status ? ` · ${error.status}` : ''}
        {error.traceId ? ` · trace ${error.traceId.slice(0, 8)}` : ''}
      </code>
    </div>
  );
}

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint && (
        <span className="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function SelectField({
  label,
  children,
  ...select
}: { label: string; children: ReactNode } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} {...select}>
        {children}
      </select>
    </div>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{children}</span>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" className="loading">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Logo({ size = 36 }: { size?: number }) {
  const { branding } = useLender();
  if (branding.logoUrl) {
    return (
      <img
        className="logo"
        src={branding.logoUrl}
        alt={branding.displayName}
        height={size}
        referrerPolicy="no-referrer"
      />
    );
  }
  const initials = branding.displayName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <span className="monogram" style={{ width: size, height: size }} aria-hidden="true">
      {initials}
    </span>
  );
}
