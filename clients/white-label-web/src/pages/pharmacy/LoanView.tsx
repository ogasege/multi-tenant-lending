import { useParams } from 'react-router-dom';

import { Badge, ErrorNote, Money, Rate, Spinner, Stat } from '../../components/ui';
import { formatDate } from '../../money/format';
import { useLender } from '../../session/lender';
import { useLoad } from '../../session/useLoad';

/** Borrower view of a loan: payoff today, schedule, status. Payments are recorded by staff. */
export function LoanView() {
  const { id = '' } = useParams();
  const { api, locale, t, branding } = useLender();
  const load = useLoad(
    async () => {
      const [loan, schedule] = await Promise.all([
        api.customer.loan(id),
        api.customer.schedule(id),
      ]);
      const payoff = loan.status === 'ACTIVE' ? await api.customer.payoff(id) : null;
      return { loan, schedule, payoff };
    },
    [api, id],
    locale,
    {
      everyMs: 10_000,
      until: ({ loan }) => loan.status !== 'ACTIVE' && loan.status !== 'PENDING_DISBURSEMENT',
    },
  );
  if (!load.data)
    return load.error ? <ErrorNote error={load.error} /> : <Spinner label={t.loading} />;
  const { loan, schedule, payoff } = load.data;
  const cur = loan.currency;

  return (
    <div className="stack">
      <div className="row-between">
        <span className="muted small">
          {loan.reference} · {loan.terms.productCode}
        </span>
        <Badge value={loan.status} />
      </div>
      {payoff ? (
        <section className="payoff" data-testid="payoff">
          <span>{t.payTodayToClose}</span>
          <span className="payoff-amount">
            <Money minor={payoff.total} currency={cur} />
          </span>
          <span className="small">
            {t.includesInterest} <Money minor={payoff.interest} currency={cur} />.{' '}
            {payoff.waivedInterest !== '0' && (
              <>
                <Money minor={payoff.waivedInterest} currency={cur} /> {t.futureInterestWaived}
              </>
            )}
          </span>
        </section>
      ) : (
        <section className="payoff">
          <span>{loan.status === 'CLOSED' ? t.loanClosed : t.awaitingDisbursement}</span>
        </section>
      )}

      <h2 className="h3">
        {t.repaymentSchedule}
        {schedule.preview && <span className="muted small"> · {t.preview}</span>}
      </h2>
      <div className="table-wrap card flush">
        <table data-testid="schedule">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{t.due}</th>
              <th scope="col" className="r">
                {t.amount}
              </th>
              <th scope="col" className="r">
                {t.status}
              </th>
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
                  <Badge value={i.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="card grid-2">
        <Stat label={t.principalLeft}>
          <Money minor={loan.outstanding.principal} currency={cur} />
        </Stat>
        <Stat label={t.daysPastDue}>
          {loan.daysPastDue} · {loan.dpdBucket}
        </Stat>
        <Stat label={t.paidTo}>{loan.payee.name}</Stat>
        <Stat label={t.apr}>
          <Rate bps={loan.aprBps} />
        </Stat>
      </section>
      <p className="muted small">
        {t.howToPay.replace('{ref}', loan.reference)} {branding.supportEmail ?? ''}
      </p>
      {load.error && (
        <div className="stack" data-testid="refresh-failed">
          <p className="muted small">{t.refreshFailed}</p>
          <ErrorNote error={load.error} />
        </div>
      )}
    </div>
  );
}
