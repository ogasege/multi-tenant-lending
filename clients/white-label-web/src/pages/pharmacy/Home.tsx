import { Link } from 'react-router-dom';

import { Logo } from '../../components/ui';
import { useLender } from '../../session/lender';

export function Home() {
  const { slug, branding, sessions, t } = useLender();
  return (
    <section className="hero">
      <Logo size={56} />
      <h1>{t.heroTitle}</h1>
      <p className="lead">{t.heroLead.replace('{lender}', branding.displayName)}</p>
      <div className="actions">
        <Link className="button" to={`/l/${slug}/checkout`}>
          {t.continueToCheckout}
        </Link>
        {!sessions.customer && (
          <Link className="button button-secondary" to={`/l/${slug}/signup`}>
            {t.openAccount}
          </Link>
        )}
      </div>
      <ul className="hero-points">
        <li>{t.heroPoint1}</li>
        <li>{t.heroPoint2}</li>
        <li>{t.heroPoint3}</li>
      </ul>
    </section>
  );
}
