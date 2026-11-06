/**
 * "Developer view": a discreet drawer showing each raw exchange (method, path, status,
 * Idempotency-Key, Idempotent-Replayed, RateLimit, serving cell) plus the theme tokens
 * derived from branding. The demo uses it to prove backend behaviour on screen.
 */
import { useState, useSyncExternalStore } from 'react';

import { devLog, type Exchange } from '../api/devlog';
import { useLender } from '../session/lender';

function ExchangeRow({ x }: { x: Exchange }) {
  const [open, setOpen] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const replayed = x.responseHeaders['idempotent-replayed'] === 'true';
  const tone = x.status >= 500 || x.status === 0 ? 'bad' : x.status >= 400 ? 'warn' : 'good';
  return (
    <li className={`dev-row${replayed ? ' dev-row-replayed' : ''}`} data-testid="dev-exchange">
      <button
        type="button"
        className="dev-row-head"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        <span className="dev-method">{x.method}</span>
        <span className="dev-path">{x.path}</span>
        <span className={`dev-status dev-${tone}`}>{x.status || 'ERR'}</span>
      </button>
      <dl className="dev-meta">
        <div>
          <dt>cell</dt>
          <dd>{x.cell}</dd>
        </div>
        <div>
          <dt>time</dt>
          <dd>{x.durationMs} ms</dd>
        </div>
        {x.idempotencyKey && (
          <div>
            <dt>Idempotency-Key</dt>
            <dd>{x.idempotencyKey}</dd>
          </div>
        )}
        {Object.entries(x.responseHeaders)
          .filter(([k]) => k !== 'content-type')
          .map(([k, v]) => (
            <div key={k} className={k === 'idempotent-replayed' ? 'dev-hl' : undefined}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        {x.redirectedTo && (
          <div>
            <dt>redirected</dt>
            <dd>307 → {x.redirectedTo}</dd>
          </div>
        )}
      </dl>
      {x.replay && (
        <button
          type="button"
          className="dev-replay"
          disabled={replaying}
          onClick={() => {
            setReplaying(true);
            void x
              .replay?.()
              .catch(() => undefined)
              .finally(() => {
                setReplaying(false);
              });
          }}
        >
          Resend with the same key
        </button>
      )}
      {open && (
        <div className="dev-bodies">
          {x.requestBody !== undefined && (
            <>
              <span>request</span>
              <pre>{JSON.stringify(x.requestBody, null, 2)}</pre>
            </>
          )}
          <span>response</span>
          <pre>{JSON.stringify(x.responseBody, null, 2)}</pre>
        </div>
      )}
    </li>
  );
}

export function DevView() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'calls' | 'theme'>('calls');
  const entries = useSyncExternalStore(devLog.subscribe, devLog.snapshot);
  const lender = useLender();

  return (
    <>
      <button
        type="button"
        className="dev-toggle"
        aria-pressed={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        Developer view {open ? '●' : '○'}
      </button>
      {open && (
        <aside className="dev-drawer" aria-label="Developer view">
          <div className="dev-head">
            <strong>Developer view</strong>
            <span className="dev-cell">
              cell {lender.cell.region} ({lender.cell.source})
            </span>
            <div className="dev-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'calls'}
                onClick={() => {
                  setTab('calls');
                }}
              >
                Calls · {entries.length}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'theme'}
                onClick={() => {
                  setTab('theme');
                }}
              >
                Theme
              </button>
              <button type="button" onClick={devLog.clear}>
                Clear
              </button>
              <button
                type="button"
                aria-label="Close developer view"
                onClick={() => {
                  setOpen(false);
                }}
              >
                ×
              </button>
            </div>
          </div>
          {tab === 'calls' ? (
            <ol className="dev-list">
              {entries.map((x) => (
                <ExchangeRow key={x.id} x={x} />
              ))}
            </ol>
          ) : (
            <div className="dev-theme">
              <p>
                Derived only from <code>GET /v1/institutions/{lender.slug}/branding</code>
              </p>
              <dl className="dev-meta">
                {Object.entries(lender.theme.tokens).map(([k, v]) => (
                  <div key={k}>
                    <dt>
                      <span className="dev-swatch" style={{ background: v }} /> {k}
                    </dt>
                    <dd>{v}</dd>
                  </div>
                ))}
                <div>
                  <dt>text on primary</dt>
                  <dd>{lender.theme.primaryRatio.toFixed(2)}:1</dd>
                </div>
                <div>
                  <dt>text on secondary</dt>
                  <dd>{lender.theme.secondaryRatio.toFixed(2)}:1</dd>
                </div>
                <div>
                  <dt>locale / currency</dt>
                  <dd>
                    {lender.locale} / {lender.currency}
                  </dd>
                </div>
                <div>
                  <dt>AA fallbacks</dt>
                  <dd>{lender.theme.adjustments.join('; ') || 'none needed'}</dd>
                </div>
              </dl>
            </div>
          )}
        </aside>
      )}
    </>
  );
}
