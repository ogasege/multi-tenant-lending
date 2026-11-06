import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { ApiError } from '../../api/api';
import type { RegisterCustomerRequest } from '../../api/types';
import { ErrorNote, Field } from '../../components/ui';
import { minorToDecimalString, parseMoneyInput } from '../../money/format';
import { useLender } from '../../session/lender';
import { useAction } from '../../session/useAction';

import {
  demoApplicantsFor,
  demoPassword,
  hasDemoApplicants,
  OUTCOMES,
  type DemoApplicant,
  type DemoOutcome,
} from './demoApplicants';

interface Form {
  businessName: string;
  businessRegistrationNumber: string;
  operatingLicenceNumber: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth: string;
  nationalId: string;
  monthsInEmployment: string;
  monthlyIncome: string;
  monthlyExpenses: string;
  password: string;
}

const EMPTY: Form = {
  businessName: '',
  businessRegistrationNumber: '',
  operatingLicenceNumber: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dateOfBirth: '',
  nationalId: '',
  monthsInEmployment: '',
  monthlyIncome: '',
  monthlyExpenses: '',
  password: '',
};

function randomDigits(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => String(b % 10)).join('');
}

/** Form values of a seeded demo applicant (amounts shown in major units). */
function formFromDemo(a: DemoApplicant): Form {
  const r = a.registration;
  return {
    businessName: r.businessName ?? '',
    businessRegistrationNumber: r.businessRegistrationNumber ?? '',
    operatingLicenceNumber: r.operatingLicenceNumber ?? '',
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    phone: r.phone,
    dateOfBirth: r.dateOfBirth,
    nationalId: r.nationalId,
    monthsInEmployment: String(r.monthsInEmployment),
    monthlyIncome: minorToDecimalString(r.monthlyIncome, r.currency),
    monthlyExpenses: minorToDecimalString(r.monthlyExpenses, r.currency),
    password: demoPassword(),
  };
}

/**
 * Random fictional applicant, used only when the seed wrote no demo applicants for this
 * lender (the mock KYC verifies any id not starting with 000; the outcome is unknown).
 */
function demoForm(slug: string, fr: boolean): Form {
  const tag = randomDigits(4);
  return {
    businessName: fr ? `Pharmacie Teranga Plus ${tag}` : `HealthPlus Pharmacy ${tag} Ltd`,
    businessRegistrationNumber: fr ? `SN-DKR-${randomDigits(7)}` : `RC${randomDigits(7)}`,
    operatingLicenceNumber: fr ? 'ONP/2023/0142' : 'PCN/PREM/2024/0001',
    firstName: fr ? 'Awa' : 'Amaka',
    lastName: fr ? 'Diop' : 'Eze',
    email: `${fr ? 'awa' : 'amaka'}.${tag}@${slug}.pharmacy.example`,
    phone: fr ? `+22177${randomDigits(7)}` : `+234803${randomDigits(7)}`,
    dateOfBirth: '1985-04-12',
    nationalId: `2${randomDigits(10)}`,
    monthsInEmployment: '48',
    monthlyIncome: fr ? '6000000' : '1500000',
    monthlyExpenses: fr ? '2400000' : '600000',
    password: `Demo-${randomDigits(6)}-Pass`,
  };
}

export function SignUp() {
  const { slug, api, signIn, currency, locale, t } = useLender();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const [form, setForm] = useState<Form>(EMPTY);
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<DemoOutcome>('APPROVE');
  const [demo, setDemo] = useState<DemoApplicant | null>(null);
  const [used, setUsed] = useState<ReadonlySet<string>>(new Set());
  const seeded = hasDemoApplicants(slug);

  /** Fills the form with the next unused demo applicant of `wanted` (or a random one). */
  const fillDemo = useCallback(
    (wanted: DemoOutcome, skip: ReadonlySet<string>) => {
      const next = demoApplicantsFor(slug, wanted, skip)[0];
      if (next) {
        setDemo(next);
        setForm(formFromDemo(next));
        return true;
      }
      setDemo(null);
      setForm(demoForm(slug, locale.startsWith('fr')));
      return false;
    },
    [slug, locale],
  );

  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const register = useCallback(
    async (body: RegisterCustomerRequest) => {
      try {
        const res = await api.customer.register(slug, body);
        await signIn('customer', res.tokens);
        return res;
      } catch (err) {
        // A demo national id registers once per lender: move on to the next one.
        if (err instanceof ApiError && err.problem.status === 409 && demo) {
          const skip = new Set(used).add(demo.registration.nationalId);
          setUsed(skip);
          setNotice(fillDemo(demo.expectedDecision, skip) ? t.demoUsedNext : t.demoUsedNone);
        }
        throw err;
      }
    },
    [api, slug, signIn, demo, used, fillDemo, t],
  );
  const action = useAction(register, locale);

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const income = parseMoneyInput(form.monthlyIncome, currency, locale);
    const expenses = parseMoneyInput(form.monthlyExpenses, currency, locale);
    if (income === null || expenses === null) {
      setLocalError(t.invalidAmount);
      return;
    }
    setLocalError(null);
    const body: RegisterCustomerRequest = {
      customerType: 'BUSINESS',
      businessName: form.businessName.trim(),
      businessRegistrationNumber: form.businessRegistrationNumber.trim(),
      operatingLicenceNumber: form.operatingLicenceNumber.trim() || undefined,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      dateOfBirth: form.dateOfBirth,
      nationalId: form.nationalId.trim(),
      employmentStatus: 'BUSINESS_OWNER',
      monthsInEmployment: Number(form.monthsInEmployment) || 0,
      currency,
      monthlyIncome: income,
      monthlyExpenses: expenses,
      existingMonthlyDebt: '0',
      password: form.password,
    };
    setNotice(null);
    void action.run(body).then((ok) => {
      if (ok) {
        void navigate(from ?? `/l/${slug}/checkout`, {
          replace: true,
          state: { productCode: demo?.request.productCode },
        });
      }
    });
  };

  return (
    <section className="card">
      <div className="row-between">
        <div>
          <h1>{t.signUpTitle}</h1>
          <p className="muted">{t.signUpLead}</p>
        </div>
        <div className="demo-picker">
          {seeded && (
            <select
              aria-label={t.demoOutcome}
              value={outcome}
              onChange={(e) => {
                setOutcome(e.target.value as DemoOutcome);
              }}
            >
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {t.demoExpect} {o}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="button button-secondary small"
            onClick={() => {
              setNotice(null);
              if (seeded && !fillDemo(outcome, used)) setNotice(t.demoUsedNone);
              if (!seeded) fillDemo(outcome, used);
            }}
          >
            {t.fillDemo}
          </button>
        </div>
      </div>
      {demo && (
        <p className="alert alert-info small" data-testid="demo-scenario">
          <span>
            <strong>{demo.expectedDecision}</strong> · {demo.scenario}
          </span>
        </p>
      )}
      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
        </div>
      )}
      <form onSubmit={submit} className="stack">
        <Field
          label={t.businessName}
          required
          value={form.businessName}
          onChange={set('businessName')}
        />
        <div className="grid-2">
          <Field
            label={t.registrationNumber}
            required
            value={form.businessRegistrationNumber}
            onChange={set('businessRegistrationNumber')}
          />
          <Field
            label={t.licenceNumber}
            value={form.operatingLicenceNumber}
            onChange={set('operatingLicenceNumber')}
          />
        </div>
        <div className="grid-2">
          <Field label={t.firstName} required value={form.firstName} onChange={set('firstName')} />
          <Field label={t.lastName} required value={form.lastName} onChange={set('lastName')} />
        </div>
        <div className="grid-2">
          <Field label={t.email} type="email" required value={form.email} onChange={set('email')} />
          <Field
            label={t.phone}
            type="tel"
            required
            placeholder="+234…"
            value={form.phone}
            onChange={set('phone')}
          />
        </div>
        <div className="grid-2">
          <Field
            label={t.dateOfBirth}
            type="date"
            required
            value={form.dateOfBirth}
            onChange={set('dateOfBirth')}
          />
          <Field
            label={t.nationalId}
            inputMode="numeric"
            pattern="\d{11}"
            required
            autoComplete="off"
            value={form.nationalId}
            onChange={set('nationalId')}
            hint={t.nationalIdHint}
          />
        </div>
        <div className="grid-3">
          <Field
            label={`${t.monthlyRevenue} (${currency})`}
            inputMode="decimal"
            required
            value={form.monthlyIncome}
            onChange={set('monthlyIncome')}
          />
          <Field
            label={`${t.monthlyExpenses} (${currency})`}
            inputMode="decimal"
            required
            value={form.monthlyExpenses}
            onChange={set('monthlyExpenses')}
          />
          <Field
            label={t.monthsTrading}
            type="number"
            min={0}
            required
            value={form.monthsInEmployment}
            onChange={set('monthsInEmployment')}
          />
        </div>
        <Field
          label={t.password}
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={form.password}
          onChange={set('password')}
          hint={t.passwordHint}
        />
        {localError && (
          <div className="alert alert-danger" role="alert">
            {localError}
          </div>
        )}
        <ErrorNote error={action.error} />
        <button className="button" type="submit" disabled={action.pending}>
          {action.pending ? t.working : t.createAccount}
        </button>
        <p className="muted">
          <Link to={`/l/${slug}/login`} state={{ from }}>
            {t.haveAccount}
          </Link>
        </p>
      </form>
    </section>
  );
}
