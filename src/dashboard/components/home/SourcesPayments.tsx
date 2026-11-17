import { memo, useMemo, useState } from 'react';
import { navigate } from '../../App';
import { fmtAgo, fmtMoney, fmtNumber, fmtPct } from '../../lib/format';
import { Favicon, Flag, SourceIcon } from '../Icons';
import { EmptyIcons, EmptyState } from '../ui';
import { currenciesOf, InfoIcon, money, NEW_CUSTOMERS_NOTE, PhoneGlyph, Popover, PROVIDERS } from './shared';
import type { HomeData, Money, Payment } from './types';

function MoneyList({ m }: { m: Money }) {
  const list = currenciesOf(m);
  if (!list.length) return <span className="text-stone-300">–</span>;
  return (
    <>
      {list.map(([cc, v]) => (
        <div key={cc}>{money(v, cc, true)}</div>
      ))}
    </>
  );
}

const APP_STORE_ROW_NOTE = "App Store sales from Apple's report that no payment linked to a visit explains.";
const NO_SOURCE_ROW_NOTE = 'Stripe and other payments with no linked visit. App Store sales have their own row.';
/** Rows before "Show all". */
const SOURCES_SHOWN = 8;

export const Sources = memo(function Sources({ sources }: { sources: HomeData['sources'] }) {
  const [all, setAll] = useState(false);
  // The share bars measure the largest currency; a row's other currencies show in its revenue column only.
  const { main, total } = useMemo(() => {
    const t: Money = {};
    for (const r of sources) for (const [cc, v] of Object.entries(r.revenue)) if (v > 0) t[cc] = (t[cc] ?? 0) + v;
    const top = currenciesOf(t)[0];
    return { main: top?.[0] ?? null, total: top?.[1] ?? 0 };
  }, [sources]);
  const rows = all ? sources : sources.slice(0, SOURCES_SHOWN);
  return (
    <section className="card p-5" aria-labelledby="sources-title">
      <div className="flex items-center gap-2">
        <h2 id="sources-title" className="text-title">
          Where customers come from
        </h2>
        <Popover label="How revenue is credited to sources" trigger={<InfoIcon size={14} />}>
          Revenue goes to the visit each payment is linked to. Payments with no linked visit, and App Store sales no payment explains, get their own rows. So the
          revenue column adds up to the Revenue tile.{main ? ` The bar under each source is its share of ${main} revenue.` : ''}
        </Popover>
      </div>
      <p className="text-[13px] text-stone-500">All sites, this period</p>
      {sources.length ? (
        <>
          <table className="mt-4 w-full text-[13px]">
            <thead>
              <tr className="text-left text-xs text-stone-500">
                <th className="pb-2 font-medium">Source</th>
                <th className="pb-2 pl-3 text-right font-medium">Visitors</th>
                <th className="pb-2 pl-3 text-right font-medium" title={NEW_CUSTOMERS_NOTE}>
                  <span className="hidden sm:inline">New customers</span>
                  <span className="sm:hidden">Customers</span>
                </th>
                <th className="pb-2 pl-3 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const synthetic = r.appStore || r.noVisit;
                const share = main && total ? Math.max(0, r.revenue[main] ?? 0) / total : 0;
                return (
                  <tr key={r.label} className="border-t border-stone-200/60 align-top">
                    <td className="py-2.5" title={r.appStore ? APP_STORE_ROW_NOTE : r.noVisit ? NO_SOURCE_ROW_NOTE : undefined}>
                      <div className="flex items-center gap-2">
                        {r.appStore ? (
                          <PhoneGlyph size={16} />
                        ) : r.noVisit ? (
                          <span className="w-4 text-center text-stone-300" aria-hidden="true">
                            –
                          </span>
                        ) : (
                          <SourceIcon source={r.label} domain={r.domain} size={16} />
                        )}
                        <span className="truncate font-medium text-ink">{r.label}</span>
                      </div>
                      <div className="pl-6 text-xs text-stone-400">
                        {r.appStore ? "Apple's report, no linked visit" : r.channel}, {r.sites} {r.sites === 1 ? 'site' : 'sites'}
                      </div>
                      {main && (
                        <div className="relative ml-6 mt-1.5 h-1 max-w-[14rem] overflow-hidden rounded-full bg-stone-100" title={`${fmtPct(share, share < 0.1 && share > 0 ? 1 : 0)} of ${main} revenue`}>
                          <div className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-revenue transition-transform duration-slower ease-out" style={{ transform: `scaleX(${Math.min(1, share)})` }} />
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pl-3 text-right tabular-nums text-ink">{synthetic ? <span className="text-stone-300">–</span> : fmtNumber(r.visitors)}</td>
                    <td className="py-2.5 pl-3 text-right tabular-nums text-ink">{synthetic ? <span className="text-stone-300">–</span> : fmtNumber(r.customers)}</td>
                    <td className="py-2.5 pl-3 text-right font-medium tabular-nums text-ink">
                      <MoneyList m={r.revenue} />
                      {main && share > 0 && <div className="text-xs font-normal text-stone-400">{fmtPct(share, share < 0.1 ? 1 : 0)}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sources.length > SOURCES_SHOWN && (
            <button className="btn-ghost mt-3 w-full" aria-expanded={all} onClick={() => setAll((a) => !a)}>
              {all ? `Show the top ${SOURCES_SHOWN}` : `Show all ${fmtNumber(sources.length)} sources`}
            </button>
          )}
        </>
      ) : (
        <EmptyState compact icon={EmptyIcons.search} title="No visitors in this period" />
      )}
    </section>
  );
});

/** A payment's amount in the site's currency, as the row shows it. */
const shownAmount = (p: Payment) => p.converted ?? { amount: p.amount, currency: p.currency, decimals: p.decimals };

/**
 * The latest payments, with renewals in a row of the same site and currency folded into one muted line ("3 renewals,
 * $8.97"), so a new $299 sale doesn't sit among a dozen $2.99 renewals at the same weight. A single renewal stays a
 * row, muted.
 */
function paymentGroups(list: Payment[]): ({ kind: 'one'; p: Payment } | { kind: 'renewals'; items: Payment[] })[] {
  const out: ({ kind: 'one'; p: Payment } | { kind: 'renewals'; items: Payment[] })[] = [];
  for (const p of list) {
    const prev = out[out.length - 1];
    const renewal = p.renewal && p.kind !== 'refund' && p.amount >= 0;
    if (renewal && prev) {
      const head = prev.kind === 'renewals' ? prev.items[0] : prev.p.renewal && prev.p.kind !== 'refund' && prev.p.amount >= 0 ? prev.p : null;
      if (head && head.siteId === p.siteId && shownAmount(head).currency === shownAmount(p).currency) {
        if (prev.kind === 'renewals') prev.items.push(p);
        else out[out.length - 1] = { kind: 'renewals', items: [prev.p, p] };
        continue;
      }
    }
    out.push({ kind: 'one', p });
  }
  return out;
}

function PaymentMeta({ p }: { p: Payment }) {
  return (
    <div className="flex items-center gap-1.5 truncate text-xs text-stone-500">
      <span className={p.kind === 'refund' ? 'text-red-600' : p.renewal ? '' : 'text-emerald-700'}>{p.kind === 'refund' ? 'Refund' : p.renewal ? 'Renewal' : 'New'}</span>
      <span className="text-stone-300">·</span>
      {PROVIDERS[p.provider] ?? p.provider}
      <span className="text-stone-300">·</span>
      {p.source ? (
        <>
          <SourceIcon source={p.source} domain={p.sourceDomain} size={12} /> {p.source}
        </>
      ) : (
        'no linked visit'
      )}
      {p.country && (
        <>
          <span className="text-stone-300">·</span>
          <Flag cc={p.country} size={12} />
        </>
      )}
    </div>
  );
}

export const Payments = memo(function Payments({ payments }: { payments: HomeData['payments'] }) {
  const groups = useMemo(() => paymentGroups(payments), [payments]);
  const now = Date.now();
  const ago = (ts: number) => <span className="shrink-0 self-start pt-0.5 text-xs tabular-nums text-stone-400">{fmtAgo(now - ts)} ago</span>;
  const row = 'flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-sm transition-colors duration-fast hover:bg-stone-50';
  return (
    <section className="card p-5" aria-labelledby="payments-title">
      <h2 id="payments-title" className="text-title">
        Latest payments
      </h2>
      <p className="text-[13px] text-stone-500">The {payments.length} most recent, whatever the period. Renewals in a row share a line.</p>
      {payments.length ? (
        <ul className="-mx-2 mt-3">
          {groups.map((g) => {
            if (g.kind === 'renewals') {
              const first = g.items[0];
              const cur = shownAmount(first);
              const sum = g.items.reduce((t, p) => t + shownAmount(p).amount, 0);
              const products = [...new Set(g.items.map((p) => p.product).filter(Boolean))];
              return (
                <li key={first.id}>
                  <button className={row} onClick={() => navigate(`/site/${first.siteId}`)} title={g.items.map((p) => `${fmtMoney(shownAmount(p).amount, cur.currency, cur.decimals)} ${p.product ?? ''}, ${fmtAgo(now - p.ts)} ago`).join('\n')}>
                    <span className="opacity-60">
                      <Favicon domain={first.siteDomain} size={18} />
                    </span>
                    <div className="min-w-0 flex-1 text-stone-500">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium tabular-nums text-stone-600">
                          {fmtNumber(g.items.length)} renewals, {fmtMoney(sum, cur.currency, cur.decimals)}
                        </span>
                        <span>{first.siteName}</span>
                      </div>
                      <div className="truncate text-xs text-stone-400">{products.length === 1 ? products[0] : products.length ? `${products.length} products` : 'Renewals'}</div>
                    </div>
                    {ago(first.ts)}
                  </button>
                </li>
              );
            }
            const p = g.p;
            const amount = shownAmount(p);
            const quietRow = p.renewal && p.kind !== 'refund';
            return (
              <li key={p.id}>
                <button className={row} onClick={() => navigate(`/site/${p.siteId}`)}>
                  <span className={quietRow ? 'opacity-60' : ''}>
                    <Favicon domain={p.siteDomain} size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    {/* Amount and site on the first line; the product wraps to its own line on a phone instead of truncating. */}
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`tabular-nums ${p.amount < 0 ? 'font-semibold text-red-600' : quietRow ? 'font-medium text-stone-600' : 'font-semibold text-ink'}`}>
                        {fmtMoney(amount.amount, amount.currency, amount.decimals)}
                      </span>
                      {p.converted && <span className="shrink-0 text-xs tabular-nums text-stone-400">paid {fmtMoney(p.amount, p.currency, p.decimals)}</span>}
                      <span className="text-stone-500">{p.siteName}</span>
                      {p.product && (
                        <span className={`min-w-0 basis-full break-all sm:basis-auto sm:truncate ${quietRow ? 'text-stone-500' : 'text-stone-600'}`} title={p.product}>
                          {p.product}
                        </span>
                      )}
                    </div>
                    <PaymentMeta p={p} />
                  </div>
                  {ago(p.ts)}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState compact icon={EmptyIcons.inbox} title="No payments yet">
          Connect Stripe, the App Store or RevenueCat in a site's Settings.
        </EmptyState>
      )}
    </section>
  );
});
