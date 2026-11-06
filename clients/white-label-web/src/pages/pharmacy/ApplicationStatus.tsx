import { useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Badge, ErrorNote, Money, Rate, Spinner, Stat } from '../../components/ui';
import { reasonText } from '../../i18n/errors';
import { formatDate, formatDateTime } from '../../money/format';
import { useLender } from '../../session/lender';
import { useAction } from '../../session/useAction';
import { useLoad } from '../../session/useLoad';

type StepState = 'done' | 'current' | 'todo' | 'failed';

function Step({ state, title, detail }: { state: StepState; title: string; detail?: string }) {
  return (
    <li className={`step step-${state}`}>
      <span className="step-dot" aria-hidden="true">
        {state === 'done' ? '✓' : state === 'failed' ? '×' : ''}
      </span>
      <span className="step-text">
        <span className="step-title">{title}</span>
        {detail && <span className="muted small">{detail}</span>}
      </span>
      <span className="sr-only">{state}</span>
    </li>
  );
}

export function ApplicationStatus() {
  const { id = '' } = useParams();
  const { slug, api, locale, t } = useLender();
  const load = useLoad(
    async () => {
      const app = await api.customer.application(id);
      const loan = app.loanId ? await api.customer.loan(app.loanId) : null;
      return { app, loan };
    },
    [api, id],
    locale,
    4000,
  );
  const withdraw = useCallback(() => api.customer.withdraw(id), [api, id]);
  const withdrawAction = useAction(withdraw, locale);

  if (!load.data)
    return load.error ? <ErrorNote error={load.error} /> : <Spinner label={t.loading} />;
  const { app, loan } = load.data;
  const a = app.latestAssessment;
  const rejected = app.status === 'REJECTED';
  const disbursed =
    loan !== null && loan.status !== 'PENDING_DISBURSEMENT' && loan.status !== 'CANCELLED';
  const headline =
    app.status === 'REJECTED'
      ? t.statusRejected
      : app.status === 'WITHDRAWN'
        ? t.statusWithdrawn
        : disbursed
          ? t.statusPaid
          : app.status === 'APPROVED'
            ? t.statusApproved
            : t.statusReview;

  return (
    <div className="stack">
      <div>
        <span className="muted small">
          {app.reference} · {app.externalOrderReference ?? ''}
        </span>
        <h1 data-testid="application-headline">{headline}</h1>
        <Badge value={app.status} />
      </div>
      <ol className="steps card" aria-label={t.progress}>
        <Step
          state="done"
          title={t.stepSubmitted}
          detail={formatDateTime(app.submittedAt, locale)}
        />
        <Step
          state={a ? (a.decision === 'DECLINE' ? 'failed' : 'done') : 'current'}
          title={t.stepAssessed}
          detail={a ? `${a.decision}${a.grade ? ` · ${a.grade}` : ''}` : t.stepAssessedWaiting}
        />
        <Step
          state={rejected ? 'failed' : app.status === 'APPROVED' ? 'done' : a ? 'current' : 'todo'}
          title={rejected ? t.stepRejected : t.stepApproved}
          detail={
            rejected
              ? app.rejectionReasonCodes.map((c) => reasonText(c, locale)).join(' · ')
              : undefined
          }
        />
        <Step
          state={disbursed ? 'done' : app.status === 'APPROVED' ? 'current' : 'todo'}
          title={t.stepSupplierPaid}
          detail={
            disbursed && loan.disbursementDate
              ? `${app.payee.name} · ${formatDate(loan.disbursementDate, locale)}`
              : app.status === 'APPROVED'
                ? t.stepWaitingDisbursement
                : app.payee.name
          }
        />
      </ol>
      <section className="card grid-2">
        <Stat label={t.requestedAmount}>
          <Money minor={app.requestedPrincipal} currency={app.currency} />
        </Stat>
        <Stat label={t.approvedAmount}>
          <Money minor={app.approvedPrincipal} currency={app.currency} />
        </Stat>
        <Stat label={t.apr}>
          <Rate bps={loan?.aprBps ?? a?.aprBps} />
        </Stat>
        <Stat label={t.offerExpires}>
          {app.expiresAt ? formatDate(app.expiresAt, locale) : '—'}
        </Stat>
      </section>
      {loan && (
        <Link className="button" to={`/l/${slug}/loans/${loan.id}`}>
          {t.viewSchedule}
        </Link>
      )}
      {(app.status === 'SUBMITTED' || app.status === 'ASSESSED') && (
        <button
          type="button"
          className="button button-secondary"
          disabled={withdrawAction.pending}
          onClick={() => {
            void withdrawAction.run().then(load.reload);
          }}
        >
          {t.withdraw}
        </button>
      )}
      <ErrorNote error={withdrawAction.error} />
      <p className="muted small">{t.autoRefresh}</p>
    </div>
  );
}
