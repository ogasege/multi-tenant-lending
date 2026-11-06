import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import type { LoanProduct, Quote } from '../../api/types';
import { ErrorNote, Money, Rate, Spinner, Stat } from '../../components/ui';
import { describeError, type FriendlyError } from '../../i18n/errors';
import { formatDate } from '../../money/format';
import { useLender } from '../../session/lender';
import { useIdempotentAction } from '../../session/useAction';
import { useLoad } from '../../session/useLoad';

import { demoCart, newOrderReference } from './cart';

type Offer =
  | { product: LoanProduct; term: number; state: 'quote'; quote: Quote }
  | { product: LoanProduct; term: number; state: 'out-of-range' }
  | { product: LoanProduct; term: number; state: 'error'; error: FriendlyError };

function defaultTerm(p: LoanProduct): number {
  if (p.terms.repaymentFrequency === 'BULLET') return p.terms.minTerm;
  return Math.min(Math.max(3, p.terms.minTerm), p.terms.maxTerm);
}

function termOptions(p: LoanProduct): number[] {
  if (p.terms.repaymentFrequency === 'BULLET') return [p.terms.minTerm];
  const out: number[] = [];
  for (let n = p.terms.minTerm; n <= Math.min(p.terms.maxTerm, p.terms.minTerm + 11); n++)
    out.push(n);
  return out;
}

export function Checkout() {
  const { slug, api, currency, locale, t } = useLender();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  /** Product the chosen demo applicant was scored for (set by the sign-up page). */
  const preferredCode = (useLocation().state as { productCode?: string } | null)?.productCode;
  const [orderReference] = useState(() => newOrderReference());
  const products = useLoad(() => api.customer.products(), [api], locale);
  const [terms, setTerms] = useState<Record<string, number>>({});
  const [offers, setOffers] = useState<Offer[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Checkout financing pays the supplier: only VENDOR-mode products apply here.
  const list = useMemo(
    () =>
      (products.data?.items ?? []).filter(
        (p) => p.status === 'ACTIVE' && p.terms.disbursementMode === 'VENDOR',
      ),
    [products.data],
  );

  const cart = useMemo(
    () => demoCart(currency, locale, params, orderReference),
    [currency, locale, params, orderReference],
  );

  useEffect(() => {
    if (list.length === 0) return;
    let cancelled = false;
    void Promise.all(
      list.map(async (product): Promise<Offer> => {
        const term = terms[product.id] ?? defaultTerm(product);
        const total = BigInt(cart.total);
        if (
          total < BigInt(product.terms.minPrincipal) ||
          total > BigInt(product.terms.maxPrincipal)
        ) {
          return { product, term, state: 'out-of-range' };
        }
        try {
          const quote = await api.customer.quote(product.id, cart.total, term);
          return { product, term, state: 'quote', quote };
        } catch (err) {
          return { product, term, state: 'error', error: describeError(err, locale) };
        }
      }),
    ).then((result) => {
      if (cancelled) return;
      setOffers(result);
      const usable = result.filter((o) => o.state === 'quote' && o.quote.aprWithinCap);
      setSelected(
        (s) =>
          s ??
          (usable.find((o) => o.product.code === preferredCode) ?? usable[0])?.product.id ??
          null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [list, terms, cart.total, api, locale, preferredCode]);

  const chosen = offers?.find((o) => o.product.id === selected);
  const canApply = chosen?.state === 'quote' && chosen.quote.aprWithinCap;

  const submit = useCallback(
    (key: string) => {
      if (chosen?.state !== 'quote') throw new Error('No offer selected');
      return api.customer.submitApplication(
        {
          productId: chosen.product.id,
          principal: cart.total,
          term: chosen.term,
          purpose: `${t.purposePrefix} ${cart.orderReference}`,
          // No payee: the lender pays the vendor of this order (checkout-orders port).
          externalOrderReference: cart.orderReference,
        },
        key,
      );
    },
    [api, chosen, cart, t],
  );
  const apply = useIdempotentAction(submit, locale);

  return (
    <div className="checkout">
      <section className="card" aria-labelledby="cart-title">
        <div className="row-between">
          <h2 id="cart-title" className="h3">
            {t.cartFrom} {cart.supplierName}
          </h2>
          <span className="muted small">{cart.orderReference}</span>
        </div>
        <ul className="cart-lines">
          {cart.lines.map((l) => (
            <li key={l.name}>
              <span>
                {l.name} × {l.quantity}
              </span>
              <Money minor={l.amount} />
            </li>
          ))}
        </ul>
        <div className="row-between total">
          <strong>{t.cartTotal}</strong>
          <strong className="big" data-testid="cart-total">
            <Money minor={cart.total} />
          </strong>
        </div>
      </section>

      <h1>{t.financeThisCart}</h1>
      {products.loading && !products.data && <Spinner label={t.loadingOffers} />}
      <ErrorNote error={products.error} />
      {offers?.length === 0 && <p className="muted">{t.noProducts}</p>}

      {offers && (
        <fieldset className="offers">
          <legend className="muted">{t.chooseRepayment}</legend>
          {offers.map((o) => {
            const disabled = o.state !== 'quote' || !o.quote.aprWithinCap;
            return (
              <label
                key={o.product.id}
                className={`offer${selected === o.product.id ? ' offer-selected' : ''}${disabled ? ' offer-disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="product"
                  value={o.product.id}
                  checked={selected === o.product.id}
                  disabled={disabled}
                  onChange={() => {
                    setSelected(o.product.id);
                  }}
                />
                <span className="offer-body">
                  <span className="row-between">
                    <span className="offer-name">{o.product.name}</span>
                    {o.state === 'quote' && (
                      <span className="offer-apr">
                        {t.apr} <Rate bps={o.quote.aprBps} />
                      </span>
                    )}
                  </span>
                  {o.state === 'quote' && o.quote.aprWithinCap && (
                    <span className="muted small">
                      {o.quote.instalments.length === 1
                        ? t.oneRepaymentOf
                        : `${o.quote.instalments.length} ×`}{' '}
                      <Money minor={o.quote.instalments[0]?.total} />{' '}
                      {o.quote.instalments.length === 1
                        ? `${t.on} ${formatDate(o.quote.maturityDate, locale)}`
                        : t.perInstalment}
                    </span>
                  )}
                  {o.state === 'quote' && !o.quote.aprWithinCap && (
                    <span className="danger-text small">
                      {t.aboveCap.replace(
                        '{cap}',
                        o.quote.maxAprBps === null ? '' : `${o.quote.maxAprBps / 100}%`,
                      )}{' '}
                      <code>APR_EXCEEDS_CAP</code>
                    </span>
                  )}
                  {o.state === 'out-of-range' && (
                    <span className="muted small">
                      {t.outOfRange} <Money minor={o.product.terms.minPrincipal} /> –{' '}
                      <Money minor={o.product.terms.maxPrincipal} />
                    </span>
                  )}
                  {o.state === 'error' && (
                    <span className="danger-text small">{o.error.message}</span>
                  )}
                </span>
                {termOptions(o.product).length > 1 && (
                  <select
                    aria-label={`${t.termFor} ${o.product.name}`}
                    value={o.term}
                    onChange={(e) => {
                      setTerms((m) => ({ ...m, [o.product.id]: Number(e.target.value) }));
                    }}
                  >
                    {termOptions(o.product).map((n) => (
                      <option key={n} value={n}>
                        {n}{' '}
                        {o.product.terms.repaymentFrequency === 'MONTHLY'
                          ? t.months
                          : t.instalmentsUnit}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            );
          })}
        </fieldset>
      )}

      {chosen?.state === 'quote' && (
        <section className="card disclosure" aria-label={t.disclosure} data-testid="disclosure">
          <Stat label={t.paidToSupplier}>
            <Money minor={chosen.quote.netDisbursed} />
          </Stat>
          <Stat label={t.financedAmount}>
            <Money minor={chosen.quote.financedPrincipal} />
          </Stat>
          <Stat label={t.arrangementFee}>
            <Money minor={chosen.quote.originationFee} />
          </Stat>
          <Stat label={t.totalInterest}>
            <Money minor={chosen.quote.totalInterest} />
          </Stat>
          <Stat label={t.totalRepayable}>
            <Money minor={chosen.quote.totalRepayable} />
          </Stat>
          <Stat label={t.totalCostOfCredit}>
            <strong className="brand-text" data-testid="tcc">
              <Money minor={chosen.quote.totalCostOfCredit} />
            </strong>
          </Stat>
          <Stat label={t.apr}>
            <strong data-testid="apr">
              <Rate bps={chosen.quote.aprBps} />
            </strong>
          </Stat>
          <p className="muted small span-all">{t.aprExplainer}</p>
        </section>
      )}

      <ErrorNote error={apply.error} />
      <div className="sticky-cta">
        <button
          className="button block"
          type="button"
          disabled={!canApply || apply.pending}
          onClick={() => {
            void apply.run().then((app) => {
              if (app) void navigate(`/l/${slug}/applications/${app.id}`);
            });
          }}
        >
          {apply.pending ? t.working : apply.error ? t.retrySameKey : t.applyCta}
        </button>
      </div>
    </div>
  );
}
