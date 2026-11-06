import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { Api } from '../../api/api';
import type { ApplicationStatus, Customer } from '../../api/types';
import { Badge, ErrorNote, Money, Spinner } from '../../components/ui';
import { formatDateTime } from '../../money/format';
import { useLender } from '../../session/lender';
import { useLoad } from '../../session/useLoad';

/** Customer records for a set of ids, fetched once each. */
export function useCustomers(api: Api, ids: string[]): Record<string, Customer> {
  const [map, setMap] = useState<Record<string, Customer>>({});
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    const missing = key.split(',').filter((id) => id && !(id in map));
    if (missing.length === 0) return;
    void Promise.all(missing.map((id) => api.customer(id).catch(() => null))).then((rows) => {
      setMap((m) => {
        const next = { ...m };
        rows.forEach((c) => {
          if (c) next[c.id] = c;
        });
        return next;
      });
    });
    // `map` is intentionally not a dependency: it only filters out already-fetched ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);
  return map;
}

export function customerName(c: Customer | undefined): string {
  if (!c) return '…';
  return c.businessName ?? `${c.firstName} ${c.lastName}`;
}

const TABS: { status: ApplicationStatus | undefined; label: string }[] = [
  { status: 'SUBMITTED', label: 'SUBMITTED' },
  { status: 'ASSESSED', label: 'ASSESSED' },
  { status: 'APPROVED', label: 'APPROVED' },
  { status: 'REJECTED', label: 'REJECTED' },
  { status: undefined, label: 'ALL' },
];

export function Applications() {
  const { slug, api, locale, t } = useLender();
  const [status, setStatus] = useState<ApplicationStatus | undefined>('SUBMITTED');
  const load = useLoad(
    () => api.staff.applications({ status, limit: 50 }),
    [api, status],
    locale,
    5000,
  );
  const items = load.data?.items ?? [];
  const customers = useCustomers(
    api.staff,
    items.map((a) => a.customerId),
  );

  return (
    <div className="stack">
      <div className="row-between">
        <h1>{t.applicationsQueue}</h1>
        <div className="tabs" role="tablist" aria-label={t.status}>
          {TABS.map((tab) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={status === tab.status}
              className="tab"
              onClick={() => {
                setStatus(tab.status);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={load.error} />
      {!load.data && !load.error && <Spinner label={t.loading} />}
      {load.data && (
        <div className="table-wrap card flush">
          <table data-testid="applications">
            <thead>
              <tr>
                <th scope="col">{t.applicant}</th>
                <th scope="col" className="r">
                  {t.amount}
                </th>
                <th scope="col">{t.submitted}</th>
                <th scope="col">{t.status}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    {t.nothingHere}
                  </td>
                </tr>
              )}
              {items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/l/${slug}/admin/applications/${a.id}`} className="cell-link">
                      <strong>{customerName(customers[a.customerId])}</strong>
                      <span className="muted small">
                        {a.reference} · {a.payee.name}
                      </span>
                    </Link>
                  </td>
                  <td className="r">
                    <Money minor={a.requestedPrincipal} currency={a.currency} />
                  </td>
                  <td>{formatDateTime(a.submittedAt, locale)}</td>
                  <td>
                    <Badge value={a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
