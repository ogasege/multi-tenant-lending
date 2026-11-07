/**
 * Route-level tests of the per-record pages: a reused window that moves from one record to
 * another must never show the previous one, and the pharmacy's status page must not freeze
 * on stale data.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ApplicationDetail,
  Assessment,
  Loan,
  LoanStatus,
  Me,
  PublicBranding,
  TokenPair,
} from './api/types';
import { routes } from './App';
import { fakeFetch, type FakeResponse, type Route } from './test/fakeFetch';

const SLUG = 'eko-medicredit';
const APP_A = '00000000-0000-4000-8000-00000000000a';
const APP_B = '00000000-0000-4000-8000-00000000000b';
const LOAN = '00000000-0000-4000-8000-0000000000c1';

const BRANDING: PublicBranding = {
  slug: SLUG,
  displayName: 'Eko MediCredit MFB',
  primaryColor: '#0B6E4F',
  secondaryColor: '#F2A541',
  locale: 'en-NG',
  supportEmail: null,
  supportPhone: null,
  websiteUrl: null,
  logoUrl: null,
  defaultCurrency: 'NGN',
  supportedCurrencies: ['NGN'],
};

const TOKENS: TokenPair = {
  accessToken: 'access',
  tokenType: 'Bearer',
  expiresIn: 900,
  refreshToken: 'refresh',
  refreshTokenExpiresAt: '2030-01-01T00:00:00Z',
};

function me(role: 'CREDIT_OFFICER' | 'CUSTOMER'): Me {
  return {
    kind: 'USER',
    id: 'user-1',
    fullName: 'Test User',
    email: 'user@eko-medicredit.example',
    role,
    permissions: [],
    institution: { slug: SLUG, displayName: BRANDING.displayName },
  };
}

function application(id: string, over: Partial<ApplicationDetail> = {}): ApplicationDetail {
  return {
    id,
    reference: `APP-${id.slice(-1)}`,
    customerId: 'cust-1',
    productId: 'prod-1',
    productVersionId: 'prodv-1',
    currency: 'NGN',
    requestedPrincipal: '50000000',
    term: 1,
    purpose: null,
    payee: { type: 'VENDOR', name: 'Supplier Ltd', account: '0123456789' },
    externalOrderReference: 'ORD-1',
    status: 'SUBMITTED',
    submittedBy: 'user-9',
    submittedAt: '2026-11-07T10:00:00Z',
    decidedBy: null,
    decidedAt: null,
    decisionNotes: null,
    rejectionReasonCodes: [],
    approvedPrincipal: null,
    expiresAt: null,
    loanId: null,
    createdAt: '2026-11-07T10:00:00Z',
    updatedAt: '2026-11-07T10:00:00Z',
    latestAssessment: null,
    ...over,
  };
}

function assessment(applicationId: string, decision: Assessment['decision']): Assessment {
  return {
    id: `asmt-${applicationId.slice(-1)}`,
    applicationId,
    modelVersion: 'scorecard-v1',
    decision,
    grade: 'E',
    points: 300,
    reasonCodes: [],
    bureauScore: 340,
    bureauDelinquent: false,
    dtiBps: 1000,
    instalmentAmount: '51000000',
    maxAffordablePrincipal: null,
    aprBps: null,
    assessedBy: 'user-1',
    createdAt: '2026-11-07T10:01:00Z',
    disclosure: {
      currency: 'NGN',
      principal: '50000000',
      originationFee: '0',
      originationFeeTreatment: 'FINANCED',
      financedPrincipal: '50000000',
      netDisbursed: '50000000',
      numberOfInstalments: 1,
      instalmentAmount: '51000000',
      totalInterest: '1000000',
      totalRepayable: '51000000',
      totalCostOfCredit: '1000000',
      aprBps: 2400,
      firstDueDate: '2026-12-07',
      maturityDate: '2026-12-07',
    },
  };
}

function loan(status: LoanStatus): Loan {
  return {
    id: LOAN,
    reference: 'LN-1',
    applicationId: APP_A,
    customerId: 'cust-1',
    currency: 'NGN',
    approvedPrincipal: '50000000',
    financedPrincipal: '50000000',
    originationFee: '0',
    netDisbursed: '50000000',
    aprBps: 2400,
    terms: {
      productCode: 'SUPPLIER_30',
      term: 1,
      repaymentFrequency: 'MONTHLY',
      interestMethod: 'FLAT',
      annualInterestRateBps: 2400,
    },
    payee: { type: 'VENDOR', name: 'Supplier Ltd', account: '0123456789' },
    status,
    approvedBy: 'user-1',
    approvedAt: '2026-11-07T10:02:00Z',
    disbursedBy: 'user-2',
    disbursedAt: '2026-11-07T10:03:00Z',
    disbursementDate: '2026-11-07',
    maturityDate: '2026-12-07',
    providerReference: null,
    closedAt: null,
    daysPastDue: 0,
    dpdBucket: 'CURRENT',
    outstanding: { principal: '0', interest: '0', fees: '0', penalties: '0', total: '0' },
    createdAt: '2026-11-07T10:02:00Z',
  };
}

/** Matches `METHOD path` (the cell prefix and query string are ignored). */
function on(method: string, path: string, reply: () => FakeResponse): Route {
  return (url, init) => {
    const pathname = new URL(url, 'http://test').pathname.replace(/^\/cell\/[^/]+/, '');
    return (init.method ?? 'GET') === method && pathname === path ? reply() : undefined;
  };
}

function boot(role: 'CREDIT_OFFICER' | 'CUSTOMER', ...routesForTest: Route[]) {
  vi.stubGlobal(
    'fetch',
    fakeFetch(
      on('GET', `/v1/institutions/${SLUG}/branding`, () => ({ body: BRANDING })),
      on('POST', '/v1/auth/login', () => ({ body: TOKENS })),
      on('GET', '/v1/me', () => ({ body: me(role) })),
      ...routesForTest,
    ),
  );
}

async function signIn(area: 'staff' | 'customer', landing: string) {
  const loginPath = area === 'staff' ? `/l/${SLUG}/admin/login` : `/l/${SLUG}/login`;
  const router = createMemoryRouter(routes, {
    initialEntries: [{ pathname: loginPath, state: { from: landing } }],
  });
  render(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), 'user@eko-medicredit.example');
  await user.type(screen.getByLabelText('Password'), 'Local-Only-Password-1');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return { router, user };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('per-record pages keyed by id', () => {
  it('does not carry a credit decision over to the next application', async () => {
    boot(
      'CREDIT_OFFICER',
      on('GET', `/v1/loan-applications/${APP_A}`, () => ({ body: application(APP_A) })),
      on('POST', `/v1/loan-applications/${APP_A}/assess`, () => ({
        body: assessment(APP_A, 'DECLINE'),
      })),
      on('GET', `/v1/loan-applications/${APP_B}`, () => ({ body: application(APP_B) })),
    );
    const { router, user } = await signIn('staff', `/l/${SLUG}/admin/applications/${APP_A}`);

    await user.click(await screen.findByRole('button', { name: 'Run credit assessment' }));
    expect(await screen.findByTestId('decision')).toHaveTextContent('DECLINE');

    await act(() => router.navigate(`/l/${SLUG}/admin/applications/${APP_B}`));
    await screen.findByText('APP-b', { exact: false });
    expect(screen.getByTestId('decision')).toHaveTextContent('Not assessed yet');
  });
});

describe('pharmacy application status', () => {
  it('shows a failed refresh instead of silently keeping the old status', async () => {
    let failing = false;
    boot('CUSTOMER', (url, init) =>
      on('GET', `/v1/loan-applications/${APP_A}`, () =>
        failing
          ? { status: 503, body: { status: 503, code: 'SERVICE_UNAVAILABLE' } }
          : { body: application(APP_A) },
      )(url, init),
    );
    await signIn('customer', `/l/${SLUG}/applications/${APP_A}`);
    expect(await screen.findByTestId('application-headline')).toHaveTextContent(/reviewing/);

    failing = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByTestId('refresh-failed')).toHaveTextContent(/couldn’t refresh/);
    expect(screen.getByTestId('application-headline')).toHaveTextContent(/reviewing/);
  });

  it('follows the loan to "supplier paid" and stops polling once the loan is closed', async () => {
    let approved = false;
    boot(
      'CUSTOMER',
      (url, init) =>
        on('GET', `/v1/loan-applications/${APP_A}`, () => ({
          body: approved
            ? application(APP_A, {
                status: 'APPROVED',
                loanId: LOAN,
                approvedPrincipal: '50000000',
              })
            : application(APP_A),
        }))(url, init),
      on('GET', `/v1/loans/${LOAN}`, () => ({ body: loan('CLOSED') })),
    );
    await signIn('customer', `/l/${SLUG}/applications/${APP_A}`);
    expect(await screen.findByTestId('application-headline')).toHaveTextContent(/reviewing/);
    expect(screen.getByText('This page refreshes automatically.')).toBeInTheDocument();

    approved = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('application-headline')).toHaveTextContent(
        'Your supplier has been paid',
      );
    });
    expect(screen.queryByText('This page refreshes automatically.')).not.toBeInTheDocument();
  });
});
