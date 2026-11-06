import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { LoanStatus } from '../../api/types';
import { Badge, ErrorNote, Money, Spinner } from '../../components/ui';
import { useLender } from '../../session/lender';
import { useLoad } from '../../session/useLoad';

import { customerName, useCustomers } from './Applications';

const TABS: (LoanStatus | undefined)[] = ['PENDING_DISBURSEMENT', 'ACTIVE', 'CLOSED', undefined];

export function Loans() {
  const { slug, api, locale, t } = useLender();
  const [status, setStatus] = useState<LoanStatus | undefined>('PENDING_DISBURSEMENT');
  const load = useLoad(() => api.staff.loans({ status, limit: 50 }), [api, status], locale, 5000);
  const items = load.data?.items ?? [];
  const customers = useCustomers(
    api.staff,
    items.map((l) => l.customerId),
  );
  return (
    <div className="stack">
      <div className="row-between">
        <h1>{t.navLoans}</h1>
        <div className="tabs" role="tablist" aria-label={t.status}>
          {TABS.map((s) => (
            <button
              key={s ?? 'ALL'}
              type="button"
              role="tab"
              className="tab"
              aria-selected={status === s}
              onClick={() => {
                setStatus(s);
              }}
            >
              {s ?? 'ALL'}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={load.error} />
      {!load.data && !load.error && <Spinner label={t.loading} />}
      {load.data && (
        <div className="table-wrap card flush">
          <table data-testid="loans">
            <thead>
              <tr>
                <th scope="col">{t.borrower}</th>
                <th scope="col">{t.payTo}</th>
                <th scope="col" className="r">
                  {t.outstanding}
                </th>
                <th scope="col">DPD</th>
                <th scope="col">{t.status}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    {t.nothingHere}
                  </td>
                </tr>
              )}
              {items.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link to={`/l/${slug}/admin/loans/${l.id}`} className="cell-link">
                      <strong>{customerName(customers[l.customerId])}</strong>
                      <span className="muted small">{l.reference}</span>
                    </Link>
                  </td>
                  <td>{l.payee.name}</td>
                  <td className="r">
                    <Money minor={l.outstanding.total} currency={l.currency} />
                  </td>
                  <td>{l.daysPastDue}</td>
                  <td>
                    <Badge value={l.status} />
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
