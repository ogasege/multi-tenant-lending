import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';

import type { RepaymentChannel } from '../../api/types';
import {
  Badge,
  ErrorNote,
  Field,
  Money,
  Rate,
  SelectField,
  Spinner,
  Stat,
} from '../../components/ui';
import { formatDate, isoDaysAgo, minorToDecimalString, parseMoneyInput } from '../../money/format';
import { useLender } from '../../session/lender';
import { useIdempotentAction } from '../../session/useAction';
import { useLoad } from '../../session/useLoad';

const CHANNELS: RepaymentChannel[] = [
  'BANK_TRANSFER',
  'MOBILE_MONEY',
  'DIRECT_DEBIT',
  'CARD',
  'CASH',
];

/** Value dates the API accepts: today and up to 3 days back (VALUE_DATE_OUT_OF_RANGE). */
const MAX_VALUE_DATE_AGE_DAYS = 3;
const today = () => isoDaysAgo(0);

export function LoanAdmin() {
  const { id = '' } = useParams();
  const { api, locale, t, sessions } = useLender();
  const me = sessions.staff?.me;
  const load = useLoad(
    async () => {
      const loan = await api.staff.loan(id);
      const [schedule, repayments, ledger, payoff] = await Promise.all([
        api.staff.schedule(id),
        api.staff.repayments(id),
        api.staff.loanLedger(id).catch(() => null),
        loan.status === 'ACTIVE' ? api.staff.payoff(id) : Promise.resolve(null),
      ]);
      return { loan, schedule, repayments: repayments.items, ledger, payoff };
    },
    [api, id],
    locale,
  );
  const { reload } = load;

  const disburseFn = useCallback(
    async (key: string) => {
      const res = await api.staff.disburse(id, key);
      reload();
      return res;
    },
    [api, id, reload],
  );
  const disburse = useIdempotentAction(disburseFn, locale);

  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState<RepaymentChannel>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [valueDate, setValueDate] = useState(today());
  const [amountError, setAmountError] = useState<string | null>(null);

  const repayFn = useCallback(
    async (key: string, minor: string) => {
      const res = await api.staff.recordRepayment(
        id,
        { amount: minor, channel, externalReference: reference || undefined, valueDate },
        key,
      );
      reload();
      return res;
    },
    [api, id, channel, reference, valueDate, reload],
  );
  const repay = useIdempotentAction(repayFn, locale);

  if (!load.data)
    return load.error ? <ErrorNote error={load.error} /> : <Spinner label={t.loading} />;
  const { loan, schedule, repayments, ledger, payoff } = load.data;
  const cur = loan.currency;
  const iApproved = loan.approvedBy !== null && loan.approvedBy === me?.id;

  const submitRepayment = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const minor = parseMoneyInput(amount, cur, locale);
    if (minor === null || minor === '0') {
      setAmountError(t.invalidAmount);
      return;
    }
    if (channel !== 'CASH' && !reference.trim()) {
      setAmountError(t.referenceRequired);
      return;
    }
    if (valueDate < isoDaysAgo(MAX_VALUE_DATE_AGE_DAYS) || valueDate > today()) {
      setAmountError(t.valueDateRange);
      return;
    }
    setAmountError(null);
    void repay.run(minor).then((r) => {
      if (r) {
        setAmount('');
        setReference('');
        repay.reset();
      }
    });
  };

  return (
    <div className="stack">
      <div className="row-between">
        <h1>
          {loan.reference} · {loan.payee.name}
        </h1>
        <Badge value={loan.status} />
      </div>

      <section className="card stack">
        <h2 className="h3">{t.disburseToSupplier}</h2>
        <div className="grid-4">
          <Stat label={`${t.payee} (${loan.payee.type})`}>{loan.payee.name}</Stat>
          <Stat label={t.account}>••••{loan.payee.account.slice(-4)}</Stat>
          <Stat label={t.netDisbursed}>
            <Money minor={loan.netDisbursed} currency={cur} />
          </Stat>
          <Stat label={t.apr}>
            <Rate bps={loan.aprBps} />
          </Stat>
        </div>
        {loan.status === 'PENDING_DISBURSEMENT' && (
          <>
            <div className={`alert ${iApproved ? 'alert-danger' : 'alert-info'}`} role="note">
              <strong>{t.makerCheckerTitle}</strong>
              <span>{iApproved ? t.makerCheckerApprover : t.makerCheckerDisburse}</span>
            </div>
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={disburse.pending}
                onClick={() => {
                  void disburse.run();
                }}
              >
                {disburse.pending ? (
                  t.working
                ) : disburse.error ? (
                  t.retrySameKey
                ) : (
                  <>
                    {t.disburse} <Money minor={loan.netDisbursed} currency={cur} />
                  </>
                )}
              </button>
              {disburse.key && (
                <code className="muted small">Idempotency-Key {disburse.key.slice(0, 8)}…</code>
              )}
            </div>
          </>
        )}
        {loan.disbursedAt && (
          <div className="alert alert-ok" role="status" data-testid="disbursed">
            <strong>✓ {t.paid}</strong>
            <span>
              {t.providerRef} {loan.providerReference ?? '—'} ·{' '}
              {loan.disbursementDate ? formatDate(loan.disbursementDate, locale) : ''}
            </span>
          </div>
        )}
        <ErrorNote error={disburse.error} />
      </section>

      {loan.status === 'ACTIVE' && (
        <section className="card stack">
          <div className="row-between">
            <h2 className="h3">{t.recordRepayment}</h2>
            {payoff && (
              <span className="muted small">
                {t.payoffToday} <Money minor={payoff.total} currency={cur} />
              </span>
            )}
          </div>
          <form className="stack" onSubmit={submitRepayment}>
            <div className="grid-4">
              <Field
                label={`${t.amount} (${cur})`}
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                }}
              />
              <SelectField
                label={t.channel}
                value={channel}
                onChange={(e) => {
                  setChannel(e.target.value as RepaymentChannel);
                }}
              >
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </SelectField>
              <Field
                label={channel === 'CASH' ? `${t.bankReference} (${t.optional})` : t.bankReference}
                value={reference}
                required={channel !== 'CASH'}
                pattern="[A-Za-z0-9_.:\-]{1,100}"
                hint={channel === 'CASH' ? undefined : t.referenceHint}
                onChange={(e) => {
                  setReference(e.target.value);
                }}
              />
              <Field
                label={t.valueDate}
                type="date"
                min={isoDaysAgo(MAX_VALUE_DATE_AGE_DAYS)}
                max={today()}
                required
                value={valueDate}
                onChange={(e) => {
                  setValueDate(e.target.value);
                }}
              />
            </div>
            {amountError && (
              <div className="alert alert-danger" role="alert">
                {amountError}
              </div>
            )}
            <ErrorNote error={repay.error} />
            <div className="actions">
              <button className="button" type="submit" disabled={repay.pending}>
                {repay.pending ? t.working : repay.error ? t.retrySameKey : t.recordRepayment}
              </button>
              {payoff && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setAmount(minorToDecimalString(payoff.total, cur));
                  }}
                >
                  {t.usePayoff}
                </button>
              )}
              {schedule.instalments.find((i) => i.status !== 'PAID') && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    const next = schedule.instalments.find((i) => i.status !== 'PAID');
                    if (next) setAmount(minorToDecimalString(next.totalOutstanding, cur));
                  }}
                >
                  {t.useNextInstalment}
                </button>
              )}
            </div>
          </form>
        </section>
      )}

      <div className="grid-2 align-start">
        <section className="card flush">
          <h2 className="h3 pad">{t.repaymentSchedule}</h2>
          <div className="table-wrap">
            <table data-testid="schedule">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">{t.due}</th>
                  <th scope="col" className="r">
                    {t.amount}
                  </th>
                  <th scope="col" className="r">
                    {t.outstanding}
                  </th>
                  <th scope="col">{t.status}</th>
                </tr>
              </thead>
              <tbody>
                {schedule.instalments.map((i) => (
                  <tr key={i.seq}>
                    <td>{i.seq}</td>
                    <td>{formatDate(i.dueDate, locale)}</td>
                    <td className="r">
                      <Money minor={i.totalDue} currency={cur} />
                    </td>
                    <td className="r">
                      <Money minor={i.totalOutstanding} currency={cur} />
                    </td>
                    <td>
                      <Badge value={i.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {repayments.length > 0 && (
            <>
              <h2 className="h3 pad">{t.repayments}</h2>
              <ul className="list">
                {repayments.map((r) => (
                  <li key={r.id} className="list-row">
                    <span>
                      {formatDate(r.valueDate, locale)} · {r.channel}
                    </span>
                    <Money minor={r.amount} currency={cur} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className="card flush">
          <h2 className="h3 pad">{t.loanJournal}</h2>
          {!ledger && <p className="muted pad">{t.ledgerNotAllowed}</p>}
          {ledger?.entries.map((e) => (
            <div key={e.id} className="journal">
              <div className="row-between small">
                <strong>{e.kind}</strong>
                <span className="muted">{formatDate(e.effectiveDate, locale)}</span>
              </div>
              <ul className="postings">
                {e.postings.map((p, i) => (
                  <li key={`${p.accountCode}-${p.direction}-${i}`}>
                    <span>
                      {p.direction === 'DEBIT' ? 'Dr' : 'Cr'} <code>{p.accountCode}</code>{' '}
                      {p.accountName}
                    </span>
                    <Money minor={p.amount} currency={cur} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
