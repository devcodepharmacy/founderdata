import { useState } from 'react';
import { api, isViewer, qs } from '../lib/api';
import { useDash } from '../lib/context';
import { fmtMoney } from '../lib/format';
import { useApi } from '../lib/useApi';
import { InfoTip } from './InfoTip';
import { ErrorLine, useSiteApi } from './site/primitives';
import { EmptyIcons, EmptyState } from './ui/EmptyState';
import { Skeleton, SkeletonRows } from './ui/Skeleton';

/** GET /api/sites/:id/income: other revenue rows in the period (src/worker/payments.ts listIncome). */
interface IncomeRow {
  id: string;
  transactionId: string;
  ts: number;
  amount: number;
  currency: string;
  decimals: number;
  kind: 'income' | 'refund';
  product: string | null;
}

/** The rows behind the Other revenue line, each with Delete, so a wrong amount can be removed and sent again. */
function IncomeList({ onChange }: { onChange: () => void }) {
  const { site, q, reloadKey } = useDash();
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { data } = useApi<IncomeRow[]>(`/api/sites/${site.id}/income?${qs(q)}`, reloadKey + version);
  const viewer = isViewer();

  const remove = async (r: IncomeRow) => {
    const what = `${r.product ?? r.transactionId}, ${fmtMoney(r.amount, r.currency, r.decimals)}`;
    if (!window.confirm(`Delete ${r.kind === 'refund' ? 'the refund of ' : ''}${what}? Revenue changes at once, and the row can't be restored.`)) return;
    setError(null);
    try {
      await api(`/api/sites/${site.id}/income/${encodeURIComponent(r.transactionId)}${r.kind === 'refund' ? '?refunded=true' : ''}`, { method: 'DELETE' });
      setVersion((v) => v + 1);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!data)
    return (
      <div className="mx-1 mb-1 space-y-2 rounded-xl bg-stone-50 px-3 py-3">
        <Skeleton className="h-3.5 w-3/5" />
        <Skeleton className="h-3.5 w-2/5" />
      </div>
    );
  return (
    <div className="fd-reveal mx-1 mb-1 rounded-xl bg-stone-50 px-3 py-2 text-[13px]">
      {data.length === 0 && <p className="text-stone-400">No other revenue in this period</p>}
      {data.map((r) => (
        <div key={r.id} className="flex items-center gap-3 py-1">
          <span className="w-16 shrink-0 text-xs text-stone-500">{new Date(r.ts).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: site.timezone })}</span>
          <span className="min-w-0 flex-1 truncate" title={`transaction_id ${r.transactionId}`}>
            {r.product ?? r.transactionId}
            {r.kind === 'refund' && <span className="ml-1.5 text-xs text-stone-500">refund</span>}
          </span>
          <span className="shrink-0 tabular-nums">{fmtMoney(r.amount, r.currency, r.decimals)}</span>
          {!viewer && (
            <button className="shrink-0 text-xs font-medium text-stone-500 hover:text-red-600" onClick={() => remove(r)}>
              Delete
            </button>
          )}
        </div>
      ))}
      {data.length >= 200 && <p className="pt-1 text-xs text-stone-400">The 200 newest. Pick a shorter period to see the others.</p>}
      {error && <p className="pt-1 text-xs text-red-600">{error}</p>}
      <p className="pt-1 text-xs text-stone-500">
        To fix an amount, send the same <code>transaction_id</code> again with the right one, or delete the row here and send it again.
      </p>
    </div>
  );
}

interface ProviderRevenue {
  provider: string;
  currency: string;
  gross: number;
  refunds: number;
  net: number;
  payments: number;
  decimals: number;
  counted: boolean;
  /** Net in the site's currency, or null when this currency is not converted yet. */
  netConverted: number | null;
}

export const PROVIDER_NAMES: Record<string, string> = {
  stripe: 'Stripe',
  app_store: 'App Store',
  app_store_sandbox: 'App Store sandbox',
  revenuecat: 'RevenueCat',
  dodo: 'Dodo Payments',
  api: 'Payments API',
  lemonsqueezy: 'Lemon Squeezy',
  polar: 'Polar',
  paddle: 'Paddle',
  gumroad: 'Gumroad',
  income: 'Other revenue',
};

/** App Store amounts are the customer price with tax, before Apple's commission. */
export const isGross = (provider: string) => provider === 'app_store' || provider === 'app_store_sandbox' || provider === 'revenuecat';
export const GROSS_HINT = "What the customer paid, tax included, before the store's commission";

/** Revenue per payment provider, in the site's currency. Payments in other currencies count converted. */
export function RevenuePanel() {
  const { site, q, money } = useDash();
  const [incomeOpen, setIncomeOpen] = useState(false);
  const [changed, setChanged] = useState(0);
  const { data, loading, error, retry } = useSiteApi<ProviderRevenue[]>(`/api/sites/${site.id}/revenue?${qs(q)}`, changed);
  const shown = (r: ProviderRevenue) => (r.currency === site.currency ? r.net : (r.netConverted ?? r.net));
  const max = Math.max(1, ...(data ?? []).filter((r) => r.counted).map(shown));
  const converted = (data ?? []).some((r) => r.currency !== site.currency && r.netConverted !== null);
  const outside = (data ?? []).some((r) => !r.counted && r.provider !== 'app_store_sandbox');
  // The counted lines add up to the Revenue tile above: each line's share of that total.
  const total = (data ?? []).filter((r) => r.counted).reduce((t, r) => t + shown(r), 0);
  const share = (r: ProviderRevenue) => (r.counted && total > 0 ? Math.round((shown(r) / total) * 100) : null);
  const left = (data ?? []).filter((r) => !r.counted && r.provider !== 'app_store_sandbox');
  // A provider paid in two currencies has a line per currency; name the currency so they don't read as duplicates.
  const lines = new Map<string, number>();
  for (const r of data ?? []) lines.set(r.provider, (lines.get(r.provider) ?? 0) + 1);

  return (
    <div className="card fd-reveal flex flex-col p-3">
      <div className="flex min-h-[32px] items-center justify-between pb-2">
        <div className="flex items-center gap-1">
          <h3 className="px-2 text-[13px] font-semibold text-ink">Revenue by provider</h3>
          {data && data.length > 0 && (
            <InfoTip label="How revenue is counted" className="text-stone-400">
              Net of refunds. App Store amounts are gross: what the customer paid, tax included, before Apple's commission. On days FounderData
              has imported Apple's daily sales report, the App Store line comes from that report. On other days, such as today, it comes from the
              purchases FounderData recorded.
              {converted && ` Payments in other currencies count in ${site.currency} at the ECB rate of the payment day.`}
              {outside && ` Some have no rate yet and stay out of the totals.`}
            </InfoTip>
          )}
        </div>
        {data && total !== 0 && <span className="pr-2.5 text-[13px] font-semibold tabular-nums text-ink">{money(total)}</span>}
      </div>
      <div className={`flex-1 space-y-0.5 transition-opacity duration-base ${loading && data ? 'opacity-60' : ''}`}>
        {error && <ErrorLine error={error} retry={retry} className="mb-2" />}
        {!data && !error && <SkeletonRows rows={2} />}
        {data && data.length === 0 && (
          <EmptyState compact icon={EmptyIcons.inbox} title="No payments in this period">
            Payments from Stripe, Dodo, the App Store or the payments API show here, split by provider.
          </EmptyState>
        )}
        {data?.map((r) => {
          const income = r.provider === 'income';
          const w = r.counted && shown(r) > 0 ? shown(r) / max : 0;
          return (
            <div key={`${r.provider}-${r.currency}`}>
              <div
                className={`group relative flex h-9 items-center rounded-lg ${income ? 'cursor-pointer' : ''}`}
                title={
                  income
                    ? 'Click to list the rows and delete a wrong one'
                    : `${r.payments} payment${r.payments === 1 ? '' : 's'}${r.refunds ? `, ${fmtMoney(r.refunds, r.currency, r.decimals)} refunded` : ''}`
                }
                onClick={income ? () => setIncomeOpen((o) => !o) : undefined}
                role={income ? 'button' : undefined}
                tabIndex={income ? 0 : undefined}
                aria-expanded={income ? incomeOpen : undefined}
                onKeyDown={income ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setIncomeOpen((o) => !o)) : undefined}
              >
                <div className="absolute inset-0 overflow-hidden rounded-lg">
                  {w > 0 && (
                    <div
                      className="h-full w-full rounded-lg bg-revenueSoft transition-transform duration-slower ease-out"
                      style={{ transform: `translateX(calc(max(${(w * 100).toFixed(2)}%, 4px) - 100%))` }}
                    />
                  )}
                </div>
                <div className="absolute inset-0 rounded-lg bg-stone-900/[0.035] opacity-0 transition-opacity duration-fast group-hover:opacity-100 dark:bg-white/[0.04]" />
                <div className="relative flex min-w-0 flex-1 items-center gap-2 px-2.5 text-sm">
                  <span className="h-2 w-2 shrink-0 rounded-[3px] bg-revenue" style={{ opacity: r.counted ? 1 : 0.3 }} aria-hidden="true" />
                  <span className="truncate">
                    {PROVIDER_NAMES[r.provider] ?? r.provider}
                    {(lines.get(r.provider) ?? 0) > 1 ? `, ${r.currency}` : ''}
                  </span>
                  {isGross(r.provider) && (
                    <span className="rounded-md bg-stone-100 px-1.5 text-[11px] font-medium text-stone-500" title={GROSS_HINT}>
                      gross
                    </span>
                  )}
                  {income && (
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={`shrink-0 text-stone-400 transition-transform duration-fast ${incomeOpen ? 'rotate-180' : ''}`}>
                      <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  {r.provider === 'app_store_sandbox' ? (
                    <span className="truncate text-xs text-stone-400">test purchases, not revenue</span>
                  ) : r.currency !== site.currency ? (
                    <span className="truncate text-xs text-stone-400">
                      {r.netConverted === null ? `${r.currency}, not converted yet, not in totals` : `paid ${fmtMoney(r.net, r.currency, r.decimals)}`}
                    </span>
                  ) : null}
                </div>
                <div className={`relative flex shrink-0 items-baseline gap-2 pr-2.5 text-sm font-medium tabular-nums ${r.counted ? 'text-ink' : 'text-stone-400'}`}>
                  {share(r) !== null && <span className="w-10 text-right text-xs font-normal text-stone-500">{share(r)}%</span>}
                  {r.currency !== site.currency && r.netConverted !== null ? money(r.netConverted) : fmtMoney(r.net, r.currency, r.decimals)}
                </div>
              </div>
              {income && incomeOpen && r === data.find((x) => x.provider === 'income') && <IncomeList onChange={() => setChanged((n) => n + 1)} />}
            </div>
          );
        })}
      </div>
      {left.length > 0 && <p className="px-3 pt-2 text-xs text-stone-400">Gray lines have no exchange rate yet and stay out of the total.</p>}
    </div>
  );
}
