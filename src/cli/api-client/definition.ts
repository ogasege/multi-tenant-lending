/*
 * The reviewer walkthrough: one loan from lender registration to repayment, then the proofs
 * (tenant isolation, segregation of duties, idempotency, cell routing, rate limiting). Same
 * order as README "Try it yourself"; see `model.ts` for the template and script helpers.
 */
import type { ApiRequest, Check, EnvironmentDef, Folder, ToolScripts, Walkthrough } from './model';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

const status = (...codes: number[]): Check =>
  codes.length === 1
    ? { name: `status is ${codes[0]}`, actual: '$status', equals: codes[0] }
    : { name: `status is one of ${codes.join(', ')}`, actual: '$status', oneOf: codes };

const field = (path: string, equals: Check['equals']): Check => ({
  name:
    typeof equals === 'object'
      ? `${path} equals ${equals.variable}`
      : `${path} is ${JSON.stringify(equals)}`,
  actual: `body.${path}`,
  equals,
});

const has = (path: string): Check => ({
  name: `${path} is present`,
  actual: `body.${path}`,
  exists: true,
});
const lacks = (path: string): Check => ({
  name: `${path} is not exposed`,
  actual: `body.${path}`,
  absent: true,
});
const problem = (code: number, problemCode: string): Check[] => [
  status(code),
  field('code', problemCode),
];

/** Pre-request snippet storing a fresh UUID under `variable`. */
const freshKey = (variable: string) => `$set('${variable}', $uuid());`;

const login = (
  key: string,
  who: string,
  tokenVariable: string,
  credentials: { slug: string; email: string; password: string },
  description: string,
  baseUrl = '{{base_url}}',
): ApiRequest => ({
  key,
  name: `Log in as ${who}`,
  description,
  method: 'POST',
  url: `${baseUrl}/v1/auth/login`,
  headers: JSON_HEADERS,
  body: {
    institutionSlug: credentials.slug,
    email: credentials.email,
    password: credentials.password,
  },
  checks: [status(200), field('tokenType', 'Bearer'), has('accessToken')],
  captures: [{ variable: tokenVariable, value: 'body.accessToken' }],
});

// --- 0 Health ------------------------------------------------------------------------------

const health: Folder = {
  key: 'health',
  name: '0 Health',
  description: 'Both cells answer readiness checks (database and Redis up). No login needed.',
  requests: [
    {
      key: 'health.home',
      name: 'Readiness of this cell',
      description: 'The cell named by `base_url`.',
      method: 'GET',
      url: '{{base_url}}/health/ready',
      checks: [status(200), field('status', 'ok')],
    },
    {
      key: 'health.remote',
      name: 'Readiness of the other cell',
      description:
        'The second region (`remote_url`). Only up with the two-region stack (`make demo-cells`).',
      method: 'GET',
      url: '{{remote_url}}/health/ready',
      checks: [status(200), field('status', 'ok')],
    },
  ],
};

// --- 1 Platform ----------------------------------------------------------------------------

const platform: Folder = {
  key: 'platform',
  name: '1 Platform',
  description:
    'The platform operator registers lenders. Each run registers a new lender with a random ' +
    'slug, homed in this cell; folder 8 uses it to show that one lender cannot see another.',
  requests: [
    {
      key: 'platform.login',
      name: 'Log in as platform admin',
      description: 'Platform administrators use their own login route and token audience.',
      method: 'POST',
      url: '{{base_url}}/v1/platform/auth/login',
      headers: JSON_HEADERS,
      body: { email: '{{platform_admin_email}}', password: '{{platform_admin_password}}' },
      checks: [status(200), field('tokenType', 'Bearer')],
      captures: [{ variable: 'platform_token', value: 'body.accessToken' }],
    },
    {
      key: 'platform.register',
      name: 'Register a lender',
      description:
        'Creates the tenant, its branding, its chart of accounts and its first admin in one ' +
        'transaction. `homeRegion` must be this cell (another region answers 422 WRONG_CELL). ' +
        'The first admin password is generated per run and kept in `new_lender_admin_password`.',
      method: 'POST',
      url: '{{base_url}}/v1/platform/institutions',
      token: 'platform_token',
      headers: JSON_HEADERS,
      pre: [
        "const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');",
        "$set('new_lender_slug', `demo-lender-${suffix}`);",
        "$set('new_lender_admin_password', `Demo-${$uuid().slice(0, 8)}-Pass1`);",
      ].join('\n'),
      body: {
        slug: '{{new_lender_slug}}',
        legalName: 'Demo Lender {{new_lender_slug}} Ltd',
        countryCode: '{{country_code}}',
        defaultCurrency: '{{currency}}',
        supportedCurrencies: ['{{currency}}'],
        lenderType: 'MICROFINANCE_BANK',
        homeRegion: '{{cell_region}}',
        timezone: '{{timezone}}',
        branding: {
          displayName: 'Demo Lender {{new_lender_slug}}',
          primaryColor: '#0B5FFF',
          secondaryColor: '#111827',
          locale: '{{locale}}',
        },
        firstAdmin: {
          fullName: 'Demo Admin',
          email: 'admin@{{new_lender_slug}}.example',
          password: '{{new_lender_admin_password}}',
        },
      },
      checks: [
        status(201),
        field('slug', { variable: 'new_lender_slug' }),
        field('homeRegion', { variable: 'cell_region' }),
        field('status', 'ACTIVE'),
        lacks('firstAdmin.password'),
        lacks('firstAdmin.passwordHash'),
      ],
      captures: [{ variable: 'new_lender_id', value: 'body.id' }],
    },
    {
      key: 'platform.list',
      name: 'List lenders',
      description: 'Cursor-paginated; `limit` is capped at 100.',
      method: 'GET',
      url: '{{base_url}}/v1/platform/institutions?limit=20',
      token: 'platform_token',
      checks: [
        status(200),
        {
          name: 'items is a list of at most 20',
          actual: 'Array.isArray(body.items) && body.items.length <= 20',
          equals: true,
        },
      ],
    },
  ],
};

// --- 2 Lender staff ------------------------------------------------------------------------

const lender: Folder = {
  key: 'lender',
  name: '2 Lender staff',
  description:
    'A lender admin reads its white-label branding and its loan products, then prices the ' +
    'checkout cart. The tenant comes from the token only; no request names a tenant id.',
  requests: [
    login(
      'lender.login',
      'lender admin',
      'admin_token',
      { slug: '{{lender_slug}}', email: '{{admin_email}}', password: '{{staff_password}}' },
      'Staff log in with the lender slug, their email and password. Tokens last 15 minutes: ' +
        'if a later request answers 401, send its folder login again.',
    ),
    {
      key: 'lender.me',
      name: 'Who am I',
      description: 'Role and tenant are read from the signed token.',
      method: 'GET',
      url: '{{base_url}}/v1/me',
      token: 'admin_token',
      checks: [status(200), field('role', 'INSTITUTION_ADMIN')],
    },
    {
      key: 'lender.branding',
      name: 'Read branding (admin)',
      description: 'Name, colours, contacts, locale and the optimistic-concurrency `version`.',
      method: 'GET',
      url: '{{base_url}}/v1/institution/branding',
      token: 'admin_token',
      checks: [status(200), has('displayName'), has('version')],
    },
    {
      key: 'lender.public-branding',
      name: 'Read branding (public)',
      description: 'What a white-label front-end loads before anyone logs in.',
      method: 'GET',
      url: '{{base_url}}/v1/institutions/{{lender_slug}}/branding',
      checks: [status(200), field('slug', { variable: 'lender_slug' }), has('primaryColor')],
    },
    {
      key: 'lender.products',
      name: 'List loan products',
      description: 'Stores the id of the checkout product (`product_code`) as `product_id`.',
      method: 'GET',
      url: '{{base_url}}/v1/loan-products?limit=100',
      token: 'admin_token',
      checks: [
        status(200),
        {
          name: 'the checkout product (product_code) exists',
          actual: "body.items.some((p) => p.code === $get('product_code'))",
          equals: true,
        },
      ],
      captures: [
        {
          variable: 'product_id',
          value: "body.items.find((p) => p.code === $get('product_code')).id",
          when: "body.items && body.items.some((p) => p.code === $get('product_code'))",
        },
      ],
    },
    {
      key: 'lender.quote',
      name: 'Quote the cart',
      description:
        'Cost of credit before anyone commits: financed principal (cart plus fee), total ' +
        'repayable, total cost of credit and the APR, checked against the platform APR cap.',
      method: 'POST',
      url: '{{base_url}}/v1/loan-products/{{product_id}}/quote',
      token: 'admin_token',
      headers: JSON_HEADERS,
      body: { principal: '{{cart_principal}}', term: 30 },
      checks: [
        status(200),
        field('currency', { variable: 'currency' }),
        field('aprWithinCap', true),
        has('totalRepayable'),
        has('aprBps'),
      ],
    },
  ],
};

// --- 3 Pharmacy ----------------------------------------------------------------------------

const pharmacy: Folder = {
  key: 'pharmacy',
  name: '3 Pharmacy',
  description:
    'A pharmacy signs up with a demo applicant (known APPROVE decision) and finances its ' +
    'cart at checkout. Each national id signs up once per lender: on a second run the ' +
    'sign-up answers 409 and the login that follows still works.',
  requests: [
    {
      key: 'pharmacy.signup',
      name: 'Sign up (demo applicant)',
      description:
        'Self-registration for this lender. The national id is stored only as a keyed HMAC ' +
        'plus its last 4 digits, and never returned. 409 means this applicant already signed ' +
        'up (the next request logs in instead). At most 30 sign-ups per lender per hour.',
      method: 'POST',
      url: '{{base_url}}/v1/institutions/{{lender_slug}}/customers/register',
      headers: JSON_HEADERS,
      body: {
        customerType: 'BUSINESS',
        businessName: '{{applicant_business_name}}',
        businessRegistrationNumber: '{{applicant_registration_number}}',
        operatingLicenceNumber: '{{applicant_licence_number}}',
        firstName: '{{applicant_first_name}}',
        lastName: '{{applicant_last_name}}',
        email: '{{applicant_email}}',
        phone: '{{applicant_phone}}',
        dateOfBirth: '1984-06-15',
        nationalId: '{{applicant_national_id}}',
        employmentStatus: 'BUSINESS_OWNER',
        monthsInEmployment: 60,
        currency: '{{currency}}',
        monthlyIncome: '{{applicant_monthly_income}}',
        monthlyExpenses: '{{applicant_monthly_expenses}}',
        existingMonthlyDebt: '0',
        password: '{{applicant_password}}',
      },
      checks: [
        status(201, 409),
        {
          name: 'national id is not returned',
          actual: "JSON.stringify(body).includes(String($get('applicant_national_id')))",
          equals: false,
        },
      ],
      captures: [
        { variable: 'customer_token', value: 'body.tokens.accessToken', when: '$status === 201' },
      ],
    },
    login(
      'pharmacy.login',
      'pharmacy',
      'customer_token',
      { slug: '{{lender_slug}}', email: '{{applicant_email}}', password: '{{applicant_password}}' },
      'Borrowers use the same login route as staff; the token carries the CUSTOMER role.',
    ),
    {
      key: 'pharmacy.me',
      name: 'My customer profile',
      description: 'A customer only ever sees its own record.',
      method: 'GET',
      url: '{{base_url}}/v1/customers/me',
      token: 'customer_token',
      checks: [
        status(200),
        field('email', { variable: 'applicant_email' }),
        lacks('nationalId'),
        lacks('nationalIdHmac'),
      ],
    },
    {
      key: 'pharmacy.apply',
      name: 'Apply at checkout',
      description:
        'Finances the cart: the supplier is paid directly at disbursement. A fresh ' +
        '`Idempotency-Key` and checkout order reference are generated per run.',
      method: 'POST',
      url: '{{base_url}}/v1/loan-applications',
      token: 'customer_token',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': '{{application_key}}' },
      pre: [freshKey('application_key'), "$set('order_reference', `ORD-${Date.now()}`);"].join(
        '\n',
      ),
      body: {
        productId: '{{product_id}}',
        principal: '{{cart_principal}}',
        term: 30,
        externalOrderReference: '{{order_reference}}',
      },
      checks: [
        status(201),
        field('status', 'SUBMITTED'),
        field('productId', { variable: 'product_id' }),
      ],
      captures: [{ variable: 'application_id', value: 'body.id' }],
    },
  ],
};

// --- 4 Credit officer ----------------------------------------------------------------------

const credit: Folder = {
  key: 'credit',
  name: '4 Credit officer',
  description: 'The credit officer runs the explainable scorecard, then approves.',
  requests: [
    login(
      'credit.login',
      'credit officer',
      'credit_token',
      { slug: '{{lender_slug}}', email: '{{credit_email}}', password: '{{staff_password}}' },
      'Credit officers assess, approve and reject; they cannot disburse.',
    ),
    {
      key: 'credit.assess',
      name: 'Assess the application',
      description:
        'Mock bureau plus scorecard: decision, grade, bureau score, debt-to-income and reason ' +
        'codes. The demo applicant is approved as requested.',
      method: 'POST',
      url: '{{base_url}}/v1/loan-applications/{{application_id}}/assess',
      token: 'credit_token',
      checks: [status(200), field('decision', 'APPROVE'), has('grade'), has('bureauScore')],
    },
    {
      key: 'credit.approve',
      name: 'Approve',
      description: 'Creates the loan in PENDING_DISBURSEMENT; stores its id as `loan_id`.',
      method: 'POST',
      url: '{{base_url}}/v1/loan-applications/{{application_id}}/approve',
      token: 'credit_token',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': '{{approval_key}}' },
      pre: freshKey('approval_key'),
      body: {},
      checks: [
        status(201),
        field('application.status', 'APPROVED'),
        field('loan.status', 'PENDING_DISBURSEMENT'),
      ],
      captures: [{ variable: 'loan_id', value: 'body.loan.id' }],
    },
  ],
};

// --- 5 Finance -----------------------------------------------------------------------------

const finance: Folder = {
  key: 'finance',
  name: '5 Finance',
  description:
    'The finance officer releases the money to the supplier. The disbursement is sent twice ' +
    'with one `Idempotency-Key`, as a client would after a timeout: the second answer is the ' +
    'stored one (`Idempotent-Replayed: true`) and the supplier is paid once.',
  requests: [
    login(
      'finance.login',
      'finance officer',
      'finance_token',
      { slug: '{{lender_slug}}', email: '{{finance_email}}', password: '{{staff_password}}' },
      'Finance officers disburse, record repayments and read the ledger and audit log.',
    ),
    {
      key: 'finance.disburse',
      name: 'Disburse',
      description: 'Generates a new `disbursement_key` and pays the supplier (mock provider).',
      method: 'POST',
      url: '{{base_url}}/v1/loans/{{loan_id}}/disburse',
      token: 'finance_token',
      headers: { 'Idempotency-Key': '{{disbursement_key}}' },
      pre: freshKey('disbursement_key'),
      checks: [
        status(200),
        field('status', 'ACTIVE'),
        has('providerReference'),
        { name: 'not a replay', actual: "$header('Idempotent-Replayed')", absent: true },
      ],
      captures: [{ variable: 'provider_reference', value: 'body.providerReference' }],
    },
    {
      key: 'finance.disburse-again',
      name: 'Disburse again (resend same key)',
      description: 'Same request, same `disbursement_key`: the stored response comes back.',
      method: 'POST',
      url: '{{base_url}}/v1/loans/{{loan_id}}/disburse',
      token: 'finance_token',
      headers: { 'Idempotency-Key': '{{disbursement_key}}' },
      checks: [
        status(200),
        {
          name: 'Idempotent-Replayed is true',
          actual: "$header('Idempotent-Replayed')",
          equals: 'true',
        },
        field('providerReference', { variable: 'provider_reference' }),
      ],
    },
  ],
};

// --- 6 Repayment ---------------------------------------------------------------------------

const repayment: Folder = {
  key: 'repayment',
  name: '6 Repayment',
  description:
    'The pharmacy pays off the loan. The repayment is also sent twice with one key; folder 8 ' +
    'reuses that key for a different amount.',
  requests: [
    {
      key: 'repayment.payoff',
      name: 'Payoff quote',
      description: 'What clears the loan today; stores `payoff_total`.',
      method: 'GET',
      url: '{{base_url}}/v1/loans/{{loan_id}}/payoff-quote',
      token: 'finance_token',
      checks: [status(200), field('loanId', { variable: 'loan_id' }), has('total')],
      captures: [{ variable: 'payoff_total', value: 'body.total' }],
    },
    {
      key: 'repayment.record',
      name: 'Record repayment',
      description:
        'Bank transfer of the payoff amount. Every channel except cash needs a bank reference ' +
        'that is new for the lender; one is generated per run.',
      method: 'POST',
      url: '{{base_url}}/v1/loans/{{loan_id}}/repayments',
      token: 'finance_token',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': '{{repayment_key}}' },
      pre: [freshKey('repayment_key'), "$set('bank_reference', `NIP-${Date.now()}`);"].join('\n'),
      body: {
        amount: '{{payoff_total}}',
        channel: 'BANK_TRANSFER',
        externalReference: '{{bank_reference}}',
      },
      checks: [
        status(201),
        field('amount', { variable: 'payoff_total' }),
        field('loanStatus', 'CLOSED'),
      ],
      captures: [{ variable: 'repayment_id', value: 'body.id' }],
    },
    {
      key: 'repayment.record-again',
      name: 'Record repayment again (resend same key)',
      description: 'Replayed: one repayment is recorded, not two.',
      method: 'POST',
      url: '{{base_url}}/v1/loans/{{loan_id}}/repayments',
      token: 'finance_token',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': '{{repayment_key}}' },
      body: {
        amount: '{{payoff_total}}',
        channel: 'BANK_TRANSFER',
        externalReference: '{{bank_reference}}',
      },
      checks: [
        status(201),
        {
          name: 'Idempotent-Replayed is true',
          actual: "$header('Idempotent-Replayed')",
          equals: 'true',
        },
        field('id', { variable: 'repayment_id' }),
      ],
    },
    {
      key: 'repayment.loan',
      name: 'Read the loan',
      description: 'Fully repaid.',
      method: 'GET',
      url: '{{base_url}}/v1/loans/{{loan_id}}',
      token: 'finance_token',
      checks: [status(200), field('status', 'CLOSED')],
    },
  ],
};

// --- 7 Ledger and audit --------------------------------------------------------------------

const books: Folder = {
  key: 'books',
  name: '7 Ledger and audit',
  description: 'The double-entry books balance and the hash-chained audit log verifies.',
  requests: [
    {
      key: 'books.trial-balance',
      name: 'Trial balance',
      description: 'Sum of debits equals sum of credits for the currency.',
      method: 'GET',
      url: '{{base_url}}/v1/ledger/trial-balance?currency={{currency}}',
      token: 'finance_token',
      checks: [
        status(200),
        field('balanced', true),
        {
          name: 'debits equal credits',
          actual: 'body.totalDebits === body.totalCredits',
          equals: true,
        },
      ],
    },
    {
      key: 'books.audit-verify',
      name: 'Verify the audit chain',
      description: 'Recomputes every entry hash of this lender’s audit log.',
      method: 'GET',
      url: '{{base_url}}/v1/audit-logs/verify',
      token: 'finance_token',
      checks: [status(200), field('valid', true), has('entriesChecked')],
    },
  ],
};

// --- 8 Proofs ------------------------------------------------------------------------------

/** 20 failed logins first (the per-client budget), so the request itself is the 21st. */
const RATE_LIMIT_BURST = 20;
const rateLimitBody = (): string =>
  "JSON.stringify({ institutionSlug: $get('lender_slug'), email: 'nobody@example.invalid', password: 'not-a-real-password-1A' })";

const rateLimitBurst: ToolScripts = {
  insomnia: [
    `// Spend this client's login budget: ${RATE_LIMIT_BURST} failed logins before the request.`,
    'const sendOne = () =>',
    '  new Promise((resolve) =>',
    '    insomnia.sendRequest(',
    '      {',
    "        url: `${insomnia.variables.get('base_url')}/v1/auth/login`,",
    "        method: 'POST',",
    '        header: [',
    "          { key: 'Content-Type', value: 'application/json' },",
    "          { key: 'X-Forwarded-For', value: insomnia.variables.get('rate_limit_client_ip') },",
    '        ],',
    `        body: { mode: 'raw', raw: ${rateLimitBody().replaceAll('$get(', 'insomnia.variables.get(')} },`,
    '      },',
    '      () => resolve(),',
    '    ),',
    '  );',
    `for (let i = 0; i < ${RATE_LIMIT_BURST}; i += 1) await sendOne();`,
  ].join('\n'),
  postman: [
    `// Spend this client's login budget: ${RATE_LIMIT_BURST} failed logins before the request.`,
    'const sendSome = (left) => {',
    '  if (left === 0) return;',
    '  pm.sendRequest(',
    '    {',
    "      url: `${pm.variables.get('base_url')}/v1/auth/login`,",
    "      method: 'POST',",
    '      header: [',
    "        { key: 'Content-Type', value: 'application/json' },",
    "        { key: 'X-Forwarded-For', value: pm.variables.get('rate_limit_client_ip') },",
    '      ],',
    `      body: { mode: 'raw', raw: ${rateLimitBody().replaceAll('$get(', 'pm.variables.get(')} },`,
    '    },',
    '    () => sendSome(left - 1),',
    '  );',
    '};',
    `sendSome(${RATE_LIMIT_BURST});`,
  ].join('\n'),
};

const proofs: Folder = {
  key: 'proofs',
  name: '8 Proofs',
  description:
    'The same rules from the outside: another lender gets 404, the approver gets 403, a ' +
    'reused key with another body gets 422, a login in the wrong region gets 307, a token ' +
    'from another region gets 421, a login flood gets 429. Run folders 1 to 6 first.',
  requests: [
    login(
      'proofs.other-lender-login',
      'admin of the lender from folder 1',
      'new_lender_admin_token',
      {
        slug: '{{new_lender_slug}}',
        email: 'admin@{{new_lender_slug}}.example',
        password: '{{new_lender_admin_password}}',
      },
      'A different tenant on the same cell.',
    ),
    {
      key: 'proofs.cross-lender',
      name: 'Another lender reads our loan: 404',
      description:
        'Row-level security hides the loan; the answer is the same as for an id that does not ' +
        'exist, so nothing reveals that it is there.',
      method: 'GET',
      url: '{{base_url}}/v1/loans/{{loan_id}}',
      token: 'new_lender_admin_token',
      checks: problem(404, 'NOT_FOUND'),
    },
    {
      key: 'proofs.sod',
      name: 'Approver disburses: 403',
      description: 'Segregation of duties: the role that approves can never release money.',
      method: 'POST',
      url: '{{base_url}}/v1/loans/{{loan_id}}/disburse',
      token: 'credit_token',
      headers: { 'Idempotency-Key': '{{sod_key}}' },
      pre: freshKey('sod_key'),
      checks: problem(403, 'FORBIDDEN'),
    },
    {
      key: 'proofs.key-reuse',
      name: 'Reuse a key for another amount: 422',
      description: 'The repayment key from folder 6 with a different body is refused.',
      method: 'POST',
      url: '{{base_url}}/v1/loans/{{loan_id}}/repayments',
      token: 'finance_token',
      headers: { ...JSON_HEADERS, 'Idempotency-Key': '{{repayment_key}}' },
      body: { amount: '100', channel: 'BANK_TRANSFER', externalReference: '{{bank_reference}}' },
      checks: problem(422, 'IDEMPOTENCY_KEY_REUSED'),
    },
    {
      key: 'proofs.redirect',
      name: 'Log in to a lender of the other region: 307',
      description:
        'The lender lives in the other cell: the login is redirected there with method and ' +
        'body kept. Redirects are not followed here so the 307 stays visible. Needs the ' +
        'two-region stack.',
      method: 'POST',
      url: '{{base_url}}/v1/auth/login',
      headers: JSON_HEADERS,
      followRedirects: false,
      body: {
        institutionSlug: '{{remote_lender_slug}}',
        email: '{{remote_staff_email}}',
        password: '{{staff_password}}',
      },
      checks: [
        status(307),
        {
          name: 'Location is the other cell',
          actual: "$header('Location')",
          equals: { variable: 'remote_login_url' },
        },
        {
          name: 'X-Tenant-Cell names the other region',
          actual: "$header('X-Tenant-Cell')",
          equals: { variable: 'remote_cell_region' },
        },
      ],
    },
    login(
      'proofs.remote-login',
      'staff of the other region (at its home cell)',
      'remote_token',
      {
        slug: '{{remote_lender_slug}}',
        email: '{{remote_staff_email}}',
        password: '{{staff_password}}',
      },
      'The same login sent where the redirect pointed.',
      '{{remote_url}}',
    ),
    {
      key: 'proofs.wrong-cell',
      name: 'Use that token in this region: 421',
      description: 'Tokens carry their cell; the problem body names the right API base URL.',
      method: 'GET',
      url: '{{base_url}}/v1/loans',
      token: 'remote_token',
      checks: [status(421), field('apiBaseUrl', { variable: 'remote_url' })],
    },
    {
      key: 'proofs.rate-limit',
      name: 'Flood the login: 429',
      description:
        `Credential routes allow 20 attempts per minute per client. The pre-request script ` +
        `first sends ${RATE_LIMIT_BURST} failed logins for an account that does not exist, so ` +
        'this request is over the limit (to repeat by hand instead, send it 21 times within a ' +
        'minute). Locally the API trusts one proxy hop, so the burst uses a random ' +
        'documentation address (198.51.100.0/24) in `X-Forwarded-For`: it spends that ' +
        'address’s budget, not yours. Behind the AWS load balancer the real client address ' +
        'is used instead.',
      method: 'POST',
      url: '{{base_url}}/v1/auth/login',
      headers: { ...JSON_HEADERS, 'X-Forwarded-For': '{{rate_limit_client_ip}}' },
      pre: "$set('rate_limit_client_ip', `198.51.100.${1 + Math.floor(Math.random() * 254)}`);",
      preTool: rateLimitBurst,
      body: {
        institutionSlug: '{{lender_slug}}',
        email: 'nobody@example.invalid',
        password: 'not-a-real-password-1A',
      },
      checks: [
        ...problem(429, 'RATE_LIMITED'),
        { name: 'Retry-After is set', actual: "$header('Retry-After')", exists: true },
      ],
    },
    {
      key: 'proofs.webhook',
      name: 'Create a webhook endpoint',
      description:
        'On the lender from folder 1. HTTPS only, public addresses only (SSRF guard). The ' +
        'signing secret is returned once, here.',
      method: 'POST',
      url: '{{base_url}}/v1/webhook-endpoints',
      token: 'new_lender_admin_token',
      headers: JSON_HEADERS,
      body: { url: '{{webhook_url}}', eventTypes: ['loan.disbursed', 'loan.repayment_received'] },
      checks: [status(201), field('status', 'ACTIVE'), has('secret')],
    },
  ],
};

// --- Environments --------------------------------------------------------------------------

const staffEmails = (slug: string) => ({
  lender_slug: slug,
  admin_email: `admin@${slug}.example`,
  credit_email: `credit@${slug}.example`,
  finance_email: `finance@${slug}.example`,
});

const NATIONAL_ID_PLACEHOLDER =
  '<from make seed: Demo applicants table, an APPROVE national id for this lender>';

const lagos: EnvironmentDef = {
  key: 'env.lagos',
  name: 'Lagos cell (localhost:3000)',
  values: {
    base_url: 'http://localhost:3000',
    remote_url: 'http://localhost:3001',
    remote_login_url: 'http://localhost:3001/v1/auth/login',
    cell_region: 'af-south-1',
    remote_cell_region: 'eu-west-3',
    ...staffEmails('arewa-pharmafinance'),
    remote_lender_slug: 'teranga-sante',
    remote_staff_email: 'credit@teranga-sante.example',
    country_code: 'NG',
    currency: 'NGN',
    timezone: 'Africa/Lagos',
    locale: 'en-NG',
    cart_principal: '50000000',
    applicant_email: 'demo.approve-1@arewa-pharmafinance.customers.example',
    applicant_national_id: NATIONAL_ID_PLACEHOLDER,
    applicant_business_name: 'GoodHealth Pharmacy Ltd',
    applicant_registration_number: 'RC1234567',
    applicant_licence_number: 'PCN/PREM/2024/900',
    applicant_first_name: 'Ngozi',
    applicant_last_name: 'Adebayo',
    applicant_phone: '+234801234600',
    applicant_monthly_income: '300000000',
    applicant_monthly_expenses: '100000000',
  },
};

const paris: EnvironmentDef = {
  key: 'env.paris',
  name: 'Paris cell (localhost:3001)',
  values: {
    base_url: 'http://localhost:3001',
    remote_url: 'http://localhost:3000',
    remote_login_url: 'http://localhost:3000/v1/auth/login',
    cell_region: 'eu-west-3',
    remote_cell_region: 'af-south-1',
    ...staffEmails('teranga-sante'),
    remote_lender_slug: 'arewa-pharmafinance',
    remote_staff_email: 'credit@arewa-pharmafinance.example',
    country_code: 'SN',
    currency: 'XOF',
    timezone: 'Africa/Dakar',
    locale: 'fr-SN',
    cart_principal: '1000000',
    applicant_email: 'demo.approve-1@teranga-sante.customers.example',
    applicant_national_id: NATIONAL_ID_PLACEHOLDER,
    applicant_business_name: 'Pharmacie du Plateau',
    applicant_registration_number: 'SN-DKR-1234567',
    applicant_licence_number: 'ONP/2024/900',
    applicant_first_name: 'Fatou',
    applicant_last_name: 'Sarr',
    applicant_phone: '+221771234600',
    applicant_monthly_income: '6000000',
    applicant_monthly_expenses: '2000000',
  },
};

export const WALKTHROUGH: Walkthrough = {
  name: 'Multi-tenant lending',
  description:
    'Reviewer walkthrough of the 10mg lending API against the local stack: one loan from ' +
    'lender registration to repayment, then the safety proofs. Run the folders in order. ' +
    'Fill in the passwords (printed by `make seed`, or the SEED_* values in .env) and the ' +
    "demo applicant's national id (seed output, Demo applicants table); choose any " +
    '`applicant_password` (12+ characters with upper case, lower case and a digit).',
  shared: {
    platform_admin_email: 'ops@platform.example',
    platform_admin_password: '<from make seed: SEED_PLATFORM_ADMIN_PASSWORD>',
    staff_password: '<from make seed: SEED_STAFF_PASSWORD>',
    applicant_password: '<choose one: 12+ characters, upper and lower case, a digit>',
    product_code: 'SUPPLIER_30',
    webhook_url: 'https://example.com/hooks/10mg',
  },
  environments: [lagos, paris],
  folders: [health, platform, lender, pharmacy, credit, finance, repayment, books, proofs],
};
