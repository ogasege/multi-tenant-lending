import { Link } from 'react-router-dom';

import { Badge, ErrorNote, Money, Spinner } from '../../components/ui';
import { formatDate } from '../../money/format';
import { useLender } from '../../session/lender';
import { useLoad } from '../../session/useLoad';

export function Account() {
  const { slug, api, locale, t } = useLender();
  const load = useLoad(
    async () => {
      const [apps, loans] = await Promise.all([api.customer.applications(), api.customer.loans()]);
      return { apps: apps.items, loans: loans.items };
    },
    [api],
    locale,
  );
  if (!load.data)
    return load.error ? <ErrorNote error={load.error} /> : <Spinner label={t.loading} />;
  return (
    <div className="stack">
      <h1>{t.myCredit}</h1>
      <h2 className="h3">{t.navLoans}</h2>
      {load.data.loans.length === 0 && <p className="muted">—</p>}
      <ul className="list card flush">
        {load.data.loans.map((l) => (
          <li key={l.id}>
            <Link to={`/l/${slug}/loans/${l.id}`} className="list-link">
              <span>
                {l.reference} · {l.payee.name}
              </span>
              <Money minor={l.approvedPrincipal} currency={l.currency} />
              <Badge value={l.status} />
            </Link>
          </li>
        ))}
      </ul>
      <h2 className="h3">{t.navApplications}</h2>
      <ul className="list card flush">
        {load.data.apps.map((a) => (
          <li key={a.id}>
            <Link to={`/l/${slug}/applications/${a.id}`} className="list-link">
              <span>
                {a.reference} · {formatDate(a.submittedAt, locale)}
              </span>
              <Money minor={a.requestedPrincipal} currency={a.currency} />
              <Badge value={a.status} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
