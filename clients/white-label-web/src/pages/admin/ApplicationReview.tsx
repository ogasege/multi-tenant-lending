import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { Assessment } from '../../api/types';
import { Badge, ErrorNote, Money, Rate, Spinner, Stat } from '../../components/ui';
import { REASON_CODES, reasonText } from '../../i18n/errors';
import { formatBps } from '../../money/format';
import { useLender } from '../../session/lender';
import { useAction, useIdempotentAction } from '../../session/useAction';
import { useLoad } from '../../session/useLoad';

import { customerName } from './Applications';

export function ApplicationReview() {
  const { id = '' } = useParams();
  const { slug, api, locale, t, sessions } = useLender();
  const me = sessions.staff?.me;
  const load = useLoad(
    async () => {
      const app = await api.staff.application(id);
      const customer = await api.staff.customer(app.customerId).catch(() => null);
      return { app, customer };
    },
    [api, id],
    locale,
  );
  const { reload } = load;
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [notes, setNotes] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);

  const assessFn = useCallback(async () => {
    const res = await api.staff.assess(id);
    setAssessment(res);
    reload();
    return res;
  }, [api, id, reload]);
  const assess = useAction(assessFn, locale);

  const approveFn = useCallback(
    async (key: string) => {
      const res = await api.staff.approve(id, notes ? { notes } : {}, key);
      reload();
      return res;
    },
    [api, id, notes, reload],
  );
  const approve = useIdempotentAction(approveFn, locale);

  const rejectFn = useCallback(async () => {
    const res = await api.staff.reject(id, { reasonCodes: reasons, notes: notes || undefined });
    reload();
    return res;
  }, [api, id, reasons, notes, reload]);
  const reject = useAction(rejectFn, locale);

  if (!load.data)
    return load.error ? <ErrorNote error={load.error} /> : <Spinner label={t.loading} />;
  const { app, customer } = load.data;
  const summary = app.latestAssessment;
  const decision = assessment?.decision ?? summary?.decision;
  const codes = assessment?.reasonCodes ?? summary?.reasonCodes ?? [];
  const iSubmitted = app.submittedBy !== null && app.submittedBy === me?.id;
  const open = app.status === 'SUBMITTED' || app.status === 'ASSESSED';

  return (
    <div className="stack">
      <div className="row-between">
        <div>
          <span className="muted small">
            {app.reference} · {app.externalOrderReference ?? '—'}
          </span>
          <h1>{customerName(customer ?? undefined)}</h1>
        </div>
        <Badge value={app.status} />
      </div>

      <div className={`alert ${iSubmitted ? 'alert-danger' : 'alert-info'}`} role="note">
        <strong>{t.makerCheckerTitle}</strong>
        <span>{iSubmitted ? t.makerCheckerSelf : t.makerCheckerBody}</span>
      </div>

      <section className="card stack">
        <div className="row-between">
          <div>
            <span className="muted small">
              {t.creditDecision} · {assessment?.modelVersion ?? 'scorecard-v1'}
            </span>
            <h2 className="h2" data-testid="decision">
              {decision
                ? `${decision}${(assessment?.grade ?? summary?.grade) ? ` · ${t.grade} ${assessment?.grade ?? summary?.grade ?? ''}` : ''}`
                : t.notAssessed}
            </h2>
          </div>
          {open && (
            <button
              type="button"
              className="button button-secondary"
              disabled={assess.pending}
              onClick={() => {
                void assess.run();
              }}
            >
              {assess.pending ? t.working : summary ? t.reassess : t.runAssessment}
            </button>
          )}
        </div>
        <ErrorNote error={assess.error} />
        {assessment && (
          <div className="grid-4">
            <Stat label={t.points}>{assessment.points}</Stat>
            <Stat label={t.bureauScore}>
              {assessment.bureauScore}
              {assessment.bureauDelinquent ? ' ⚠' : ''}
            </Stat>
            <Stat label="DTI">{formatBps(assessment.dtiBps, locale)}</Stat>
            <Stat label={t.apr}>
              <Rate bps={assessment.aprBps} />
            </Stat>
          </div>
        )}
        {(assessment?.maxAffordablePrincipal ?? summary?.maxAffordablePrincipal) && (
          <p className="small">
            {t.maxAffordable}{' '}
            <Money
              minor={assessment?.maxAffordablePrincipal ?? summary?.maxAffordablePrincipal}
              currency={app.currency}
            />
          </p>
        )}
        <div>
          <span className="small strong">{t.reasonCodes}</span>
          <div className="chips" data-testid="reason-codes">
            {codes.length === 0 && <span className="muted small">{decision ? t.none : '—'}</span>}
            {codes.map((c) => (
              <span key={c} className="chip">
                <code>{c.slice(0, 3)}</code> {reasonText(c, locale)}
              </span>
            ))}
          </div>
        </div>
        <div className="grid-3 divider">
          <Stat label={`${t.payTo} (${app.payee.type})`}>
            {app.payee.name}
            <span className="muted small"> ••••{app.payee.account.slice(-4)}</span>
          </Stat>
          <Stat label={t.requestedAmount}>
            <Money minor={app.requestedPrincipal} currency={app.currency} />
          </Stat>
          {assessment ? (
            <Stat label={t.totalCostOfCredit}>
              <Money minor={assessment.disclosure.totalCostOfCredit} currency={app.currency} />
            </Stat>
          ) : (
            <Stat label={t.term}>{app.term}</Stat>
          )}
        </div>
      </section>

      {open && (
        <section className="card stack">
          <div className="field">
            <label htmlFor="notes">{t.decisionNotes}</label>
            <textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
              }}
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={approve.pending || !summary}
              onClick={() => {
                void approve.run();
              }}
            >
              {approve.pending ? t.working : approve.error ? t.retrySameKey : t.approve}
            </button>
            {approve.key && (
              <code className="muted small">Idempotency-Key {approve.key.slice(0, 8)}…</code>
            )}
          </div>
          <ErrorNote error={approve.error} />
          <details>
            <summary>{t.rejectWithReasons}</summary>
            <fieldset className="checks">
              <legend className="sr-only">{t.reasonCodes}</legend>
              {REASON_CODES.map((c) => (
                <label key={c} className="check">
                  <input
                    type="checkbox"
                    checked={reasons.includes(c)}
                    onChange={(e) => {
                      setReasons((r) => (e.target.checked ? [...r, c] : r.filter((x) => x !== c)));
                    }}
                  />
                  <code>{c.slice(0, 3)}</code> {reasonText(c, locale)}
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              className="button button-danger"
              disabled={reasons.length === 0 || reject.pending}
              onClick={() => {
                void reject.run();
              }}
            >
              {t.reject}
            </button>
            <ErrorNote error={reject.error} />
          </details>
        </section>
      )}

      {app.loanId && (
        <Link className="button" to={`/l/${slug}/admin/loans/${app.loanId}`}>
          {t.openLoan}
        </Link>
      )}
    </div>
  );
}
