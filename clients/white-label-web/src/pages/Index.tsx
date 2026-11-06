import { Link } from 'react-router-dom';

import manifest from '../../demo-brands/lenders.json';

/**
 * Neutral entry page for local demos: links to each demo lender's address. In production each
 * lender has its own host name and this page does not exist. Nothing here themes anything.
 */
export function Index() {
  return (
    <main className="index">
      <h1>10mg white-label credit</h1>
      <p className="muted">
        One build, one backend. Each address below is themed only by that lender&apos;s branding
        API.
      </p>
      <ul className="index-list">
        {manifest.lenders.map((l) => (
          <li key={l.slug}>
            <Link to={`/l/${l.slug}`}>
              <strong>/l/{l.slug}</strong>
              <span className="muted small">
                {l.legalName} · {l.city} · {l.currency} · {l.homeRegion}
              </span>
            </Link>
            <Link className="small" to={`/l/${l.slug}/admin`}>
              back-office
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
