import { type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useParams } from 'react-router-dom';

import { AdminShell, PharmacyShell, RequireSession } from './components/Shells';
import { ApplicationReview } from './pages/admin/ApplicationReview';
import { Applications } from './pages/admin/Applications';
import { Audit, Ledger } from './pages/admin/LedgerAudit';
import { LoanAdmin } from './pages/admin/LoanAdmin';
import { Loans } from './pages/admin/Loans';
import { Index } from './pages/Index';
import { Login } from './pages/Login';
import { Account } from './pages/pharmacy/Account';
import { ApplicationStatus } from './pages/pharmacy/ApplicationStatus';
import { Checkout } from './pages/pharmacy/Checkout';
import { Home } from './pages/pharmacy/Home';
import { LoanView } from './pages/pharmacy/LoanView';
import { SignUp } from './pages/pharmacy/SignUp';
import { LenderProvider } from './session/lender';

/** `/l/:slug/...` stands in for a lender's own sub-domain (`{slug}.credit.example`). */
function LenderRoot() {
  const { slug = '' } = useParams();
  return (
    <LenderProvider key={slug} slug={slug}>
      <Outlet />
    </LenderProvider>
  );
}

function Pharmacy() {
  return (
    <PharmacyShell>
      <Outlet />
    </PharmacyShell>
  );
}

function Admin() {
  return (
    <AdminShell>
      <Outlet />
    </AdminShell>
  );
}

const customer = (el: ReactNode) => <RequireSession area="customer">{el}</RequireSession>;
const staff = (el: ReactNode) => <RequireSession area="staff">{el}</RequireSession>;

export const routes = [
  { path: '/', element: <Index /> },
  {
    path: '/l/:slug',
    element: <LenderRoot />,
    children: [
      {
        element: <Pharmacy />,
        children: [
          { index: true, element: <Home /> },
          { path: 'signup', element: <SignUp /> },
          { path: 'login', element: <Login area="customer" /> },
          { path: 'checkout', element: customer(<Checkout />) },
          { path: 'applications/:id', element: customer(<ApplicationStatus />) },
          { path: 'loans/:id', element: customer(<LoanView />) },
          { path: 'account', element: customer(<Account />) },
        ],
      },
      {
        path: 'admin',
        element: <Admin />,
        children: [
          { index: true, element: <Navigate to="applications" replace /> },
          { path: 'login', element: <Login area="staff" /> },
          { path: 'applications', element: staff(<Applications />) },
          { path: 'applications/:id', element: staff(<ApplicationReview />) },
          { path: 'loans', element: staff(<Loans />) },
          { path: 'loans/:id', element: staff(<LoanAdmin />) },
          { path: 'ledger', element: staff(<Ledger />) },
          { path: 'audit', element: staff(<Audit />) },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

const router = createBrowserRouter(routes);

export function App() {
  return <RouterProvider router={router} />;
}
