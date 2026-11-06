import { type ReactNode } from 'react';
import { Link, NavLink, Navigate, useLocation } from 'react-router-dom';

import { useLender, type Area } from '../session/lender';

import { DevView } from './DevView';
import { Logo } from './ui';

export function PharmacyShell({ children }: { children: ReactNode }) {
  const { slug, branding, sessions, signOut, t } = useLender();
  const session = sessions.customer;
  return (
    <div className="app pharmacy">
      <header className="topbar">
        <Link to={`/l/${slug}`} className="brand">
          <Logo />
          <span className="brand-name">{branding.displayName}</span>
        </Link>
        <nav className="topbar-nav" aria-label={t.navAccount}>
          {session ? (
            <>
              <Link to={`/l/${slug}/account`}>{t.myCredit}</Link>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  signOut('customer');
                }}
              >
                {t.signOut}
              </button>
            </>
          ) : (
            <Link to={`/l/${slug}/login`}>{t.signIn}</Link>
          )}
        </nav>
      </header>
      <main className="content">{children}</main>
      <footer className="footer">
        <span>
          {branding.supportEmail ?? ''}
          {branding.supportPhone ? ` · ${branding.supportPhone}` : ''}
        </span>
        <Link to={`/l/${slug}/admin`} className="footer-link">
          {t.lenderStaff}
        </Link>
        <DevView />
      </footer>
    </div>
  );
}

/** Each entry shows only when `GET /v1/me` lists its permission. */
const NAV: {
  to: string;
  label: 'navApplications' | 'navLoans' | 'navLedger' | 'navAudit';
  permission: string;
}[] = [
  { to: 'applications', label: 'navApplications', permission: 'application:read' },
  { to: 'loans', label: 'navLoans', permission: 'loan:read' },
  { to: 'ledger', label: 'navLedger', permission: 'ledger:read' },
  { to: 'audit', label: 'navAudit', permission: 'audit:read' },
];

export function AdminShell({ children }: { children: ReactNode }) {
  const { slug, branding, sessions, signOut, t } = useLender();
  const session = sessions.staff;
  const me = session?.me;
  return (
    <div className="app admin">
      <nav className="sidebar" aria-label={t.backOffice}>
        <Link to={`/l/${slug}/admin`} className="brand brand-inverse">
          <Logo size={32} />
          <span className="brand-name">{branding.displayName}</span>
        </Link>
        {NAV.filter((n) => me?.permissions.includes(n.permission)).map((n) => (
          <NavLink key={n.to} to={`/l/${slug}/admin/${n.to}`} className="side-link">
            {t[n.label]}
          </NavLink>
        ))}
        <div className="side-user">
          {session && (
            <>
              <span className="side-user-name">{me?.fullName ?? '…'}</span>
              <span className="side-user-email">{me?.email}</span>
              <span className="side-user-role">{me?.role}</span>
              <button
                type="button"
                className="link-button inverse"
                onClick={() => {
                  signOut('staff');
                }}
              >
                {t.switchUser}
              </button>
            </>
          )}
        </div>
      </nav>
      <div className="admin-main">
        <main className="content wide">{children}</main>
        <footer className="footer">
          <Link to={`/l/${slug}`} className="footer-link">
            {t.borrowerSite}
          </Link>
          <DevView />
        </footer>
      </div>
    </div>
  );
}

/** Renders children only for a signed-in session of `area`; otherwise goes to its login. */
export function RequireSession({ area, children }: { area: Area; children: ReactNode }) {
  const { slug, sessions } = useLender();
  const location = useLocation();
  if (sessions[area]) return <>{children}</>;
  const login = area === 'staff' ? `/l/${slug}/admin/login` : `/l/${slug}/login`;
  return <Navigate to={login} replace state={{ from: location.pathname + location.search }} />;
}
