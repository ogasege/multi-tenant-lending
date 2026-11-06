import { useCallback } from 'react';

import { Badge, ErrorNote, Money, Spinner } from '../../components/ui';
import { formatDate, formatDateTime, isoDaysAgo } from '../../money/format';
import { useLender } from '../../session/lender';
import { useAction } from '../../session/useAction';
import { useLoad } from '../../session/useLoad';

export function Ledger() {
  const { api, locale, t, sessions } = useLender();
  const load = useLoad(() => api.staff.trialBalance(), [api], locale);
  const { reload } = load;
  const tb = load.data;
  const eodFn = useCallback(async () => {
    // End-of-day closes the PREVIOUS business date (today is still open).
    const res = await api.staff.endOfDay(isoDaysAgo(1));
    reload();
    return res;
  }, [api, reload]);
  const eod = useAction(eodFn, locale);
  return (
    <div className="stack">
      <div className="row-between">
        <h1>
          {t.trialBalance} {tb ? `· ${tb.currency}` : ''}
        </h1>
        {tb && (
          <span
            className={`badge big ${tb.balanced ? 'badge-ok' : 'badge-danger'}`}
            data-testid="balanced"
          >
            {tb.balanced ? `${t.balanced} ✓` : t.notBalanced}
          </span>
        )}
      </div>
      <ErrorNote error={load.error} />
      {!tb && !load.error && <Spinner label={t.loading} />}
      {tb && (
        <div className="table-wrap card flush">
          <table>
            <thead>
              <tr>
                <th scope="col">{t.account}</th>
                <th scope="col">{t.type}</th>
                <th scope="col" className="r">
                  {t.debits}
                </th>
                <th scope="col" className="r">
                  {t.credits}
                </th>
                <th scope="col" className="r">
                  {t.balance}
                </th>
              </tr>
            </thead>
            <tbody>
              {tb.accounts.map((a) => (
                <tr key={a.code}>
                  <td>
                    <code className="muted">{a.code}</code> {a.name}
                  </td>
                  <td className="muted small">{a.type}</td>
                  <td className="r">
                    <Money minor={a.debits} currency={tb.currency} />
                  </td>
                  <td className="r">
                    <Money minor={a.credits} currency={tb.currency} />
                  </td>
                  <td className="r">
                    <Money minor={a.balance} currency={tb.currency} />
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td>{t.total}</td>
                <td />
                <td className="r">
                  <Money minor={tb.totalDebits} currency={tb.currency} />
                </td>
                <td className="r">
                  <Money minor={tb.totalCredits} currency={tb.currency} />
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">{t.ledgerExplainer}</p>
      {sessions.staff?.me?.permissions.includes('operations:run') && (
        <div className="actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={eod.pending}
            onClick={() => {
              void eod.run();
            }}
          >
            {t.runEndOfDay}
          </button>
          {eod.result && (
            <span className="muted small" role="status" data-testid="eod-summary">
              ✓{' '}
              {t.eodSummary
                .replace('{date}', formatDate(eod.result.asOf, locale))
                .replace('{processed}', String(eod.result.loansProcessed))
                .replace('{accruals}', String(eod.result.interestAccruals))
                .replace('{fees}', String(eod.result.lateFees))
                .replace('{expired}', String(eod.result.applicationsExpired))}
              {(eod.result.loansFailed.length > 0 || eod.result.applicationsFailed.length > 0) &&
                ` ${t.eodFailures
                  .replace('{loans}', String(eod.result.loansFailed.length))
                  .replace('{apps}', String(eod.result.applicationsFailed.length))}`}
            </span>
          )}
          <ErrorNote error={eod.error} />
        </div>
      )}
    </div>
  );
}

export function Audit() {
  const { api, locale, t } = useLender();
  const load = useLoad(() => api.staff.auditLogs({ limit: 30 }), [api], locale);
  const verifyFn = useCallback(() => api.staff.verifyAudit(), [api]);
  const verify = useAction(verifyFn, locale);
  const v = verify.result;
  return (
    <div className="stack">
      <div className="row-between">
        <h1>{t.auditChain}</h1>
        <div className="actions">
          {v && (
            <span
              className={`badge big ${v.valid ? 'badge-ok' : 'badge-danger'}`}
              data-testid="audit-verified"
            >
              {v.valid
                ? `${t.verified} ✓ · ${v.entriesChecked} ${t.entries}`
                : `${t.broken} #${v.firstBrokenEntryId ?? '?'}`}
            </span>
          )}
          <button
            type="button"
            className="button"
            disabled={verify.pending}
            onClick={() => {
              void verify.run();
            }}
          >
            {verify.pending ? t.working : t.verifyChain}
          </button>
        </div>
      </div>
      <ErrorNote error={verify.error ?? load.error} />
      {!load.data && !load.error && <Spinner label={t.loading} />}
      {load.data && (
        <ol className="audit card flush">
          {load.data.items.map((e) => (
            <li key={e.id}>
              <span className="muted mono">#{e.id}</span>
              <span className="audit-main">
                <strong>{e.action}</strong>
                <span className="muted small">
                  {e.actorType} · {formatDateTime(e.occurredAt, locale)}
                </span>
              </span>
              <Badge value={e.entityType} />
              <code className="hash" title={e.hash}>
                {e.hash.slice(0, 8)}… ← {e.prevHash.slice(0, 6)}…
              </code>
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">{t.auditExplainer}</p>
    </div>
  );
}
