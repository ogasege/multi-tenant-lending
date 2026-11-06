import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { ErrorNote, Field } from '../components/ui';
import { useLender, type Area } from '../session/lender';
import { useAction } from '../session/useAction';

/** Sign-in for either side; the institution comes from the URL, never from a picker. */
export function Login({ area }: { area: Area }) {
  const { slug, api, signIn, locale, t, branding } = useLender();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useCallback(async () => {
    const tokens = await api[area].login(slug, email.trim(), password);
    await signIn(area, tokens);
    return tokens;
  }, [api, area, slug, email, password, signIn]);
  const action = useAction(login, locale);

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    void action.run().then((ok) => {
      if (ok) {
        void navigate(
          from ?? (area === 'staff' ? `/l/${slug}/admin/applications` : `/l/${slug}/checkout`),
          { replace: true },
        );
      }
    });
  };

  return (
    <section className="card narrow">
      <h1>{area === 'staff' ? t.staffSignIn : t.signIn}</h1>
      <p className="muted">{branding.displayName}</p>
      <form onSubmit={submit} className="stack">
        <Field
          label={t.email}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
        />
        <Field
          label={t.password}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        <ErrorNote error={action.error} />
        <button className="button" type="submit" disabled={action.pending}>
          {action.pending ? t.working : t.signIn}
        </button>
      </form>
      {area === 'customer' && (
        <p className="muted">
          <Link to={`/l/${slug}/signup`} state={{ from }}>
            {t.openAccount}
          </Link>
        </p>
      )}
    </section>
  );
}
