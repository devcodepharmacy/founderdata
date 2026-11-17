import { useState } from 'react';
import type { Coverage, ProviderCoverage } from '../lib/api';
import { fmtMoney, fmtNumber } from '../lib/format';
import { Modal } from './Modal';
import { PROVIDER_NAMES } from './RevenuePanel';

/**
 * Attribution coverage (GET /api/sites/:id/coverage, docs/GUIDE.md "Payments not linked to a visit"): how many
 * payments are linked to a visit, and per provider why the others are not.
 */

export const COVERAGE_GUIDE = 'https://github.com/datPascal/founderdata/blob/main/docs/GUIDE.md#payments-not-linked-to-a-visit';

/** What links a payment to its visit, per provider, for payments that arrived with no visitor id. */
const LINK_FIX: Record<string, string> = {
  stripe:
    'Put the ids from window.founderdata.attribution() in the Checkout Session metadata, and in subscription_data.metadata for subscriptions. Payment Links on a page with the script get them without code.',
  dodo: 'Pass rt_visitor_id and rt_session_id as checkout metadata. Also set the return URL to a page that loads the script: Dodo adds the payment id to it, and FounderData links the payment from there.',
  app_store: 'Buy with product.purchase(options: [.appAccountToken(FounderData.appAccountToken)]). Apple sends that token back with the transaction.',
  revenuecat: 'Call Purchases.shared.attribution.setAttributes(FounderData.revenueCatAttributes) before each purchase.',
  api: 'Send visitor_id with each payment: rt_visitor_id from window.founderdata.attribution() in the browser.',
};
const GENERIC_FIX = "Pass the ids from window.founderdata.attribution() in the checkout's custom data. The guide names the field for each provider.";

const plural = (n: number, one: string, many: string) => `${fmtNumber(n)} ${n === 1 ? one : many}`;

/** "12 payments in 30 days, 11 linked to a visit", for a provider's status line in Settings. */
export function coverageStatus(c: ProviderCoverage | undefined, days: number): string | null {
  if (!c?.payments) return null;
  return `${plural(c.payments, 'payment', 'payments')} in ${days} days, ${c.linked === c.payments ? 'all' : fmtNumber(c.linked)} linked to a visit`;
}

/** Why one provider's payments are not linked, one line per cause, with what fixes it. */
export function CoverageReasons({ c }: { c: ProviderCoverage }) {
  const n = c.notLinked;
  const lines: string[] = [];
  if (n.noIds) lines.push(`${plural(n.noIds, 'payment arrived', 'payments arrived')} with no visitor id. ${LINK_FIX[c.provider] ?? GENERIC_FIX}`);
  if (n.withEmail)
    lines.push(
      `${plural(n.withEmail, 'payment has', 'payments have')} the buyer's email, but no visitor was identified with it. Call window.founderdata('identify', { email }) at signup or login, then press Try matching again on the Customers tab.`,
    );
  if (n.renewals)
    lines.push(`${plural(n.renewals, 'is a renewal', 'are renewals')} of a subscription whose first payment is not linked either. Renewals follow the first payment.`);
  if (n.beforeTracking)
    lines.push(`${plural(n.beforeTracking, 'payment was', 'payments were')} made before this site's first recorded visit, such as imported history. Nothing can link those.`);
  return (
    <ul className="list-disc space-y-1 pl-5">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

/**
 * The line under the overview tiles: "72 of 80 payments ($6,120 of $6,650) are linked to a visit. 8 are not: how to
 * fix". Hidden without payments.
 */
export function CoverageLine({ data, settingsHref }: { data: Coverage | null; settingsHref: string }) {
  const [open, setOpen] = useState(false);
  if (!data?.payments) return null;
  const money = (n: number) => fmtMoney(n, data.currency, data.decimals);
  const missing = data.payments - data.linked;
  const all = missing === 0;
  return (
    <div className="border-b border-stone-100 px-5 py-2 text-sm text-stone-500">
      <span title="Recorded payments in this period, refunds and sandbox purchases left out. Revenue from Apple's sales report that no payment explains is not counted here.">
        {all
          ? `All ${plural(data.payments, 'payment', 'payments')} (${money(data.amount)}) are linked to a visit.`
          : `${fmtNumber(data.linked)} of ${plural(data.payments, 'payment', 'payments')} (${money(data.linkedAmount)} of ${money(data.amount)}) are linked to a visit.`}
      </span>
      {!all && (
        <>
          {' '}
          {fmtNumber(missing)} {missing === 1 ? 'is' : 'are'} not.{' '}
          <button className="text-ink underline" onClick={() => setOpen(true)}>
            How to fix
          </button>
        </>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Payments not linked to a visit">
        <div className="space-y-5 text-sm text-stone-600">
          <p>
            A payment links to a visit through the visitor id it carries. Without one, FounderData tries the return page, an earlier payment by the same customer and
            the buyer's email. When none of these work, the revenue shows in a No source row, without a channel.
          </p>
          {data.providers
            .filter((p) => p.linked < p.payments)
            .map((p) => (
              <div key={p.provider}>
                <div className="mb-1 font-medium text-ink">
                  {PROVIDER_NAMES[p.provider] ?? p.provider}: {fmtNumber(p.payments - p.linked)} of {plural(p.payments, 'payment', 'payments')} not linked
                </div>
                <CoverageReasons c={p} />
              </div>
            ))}
          <p>
            <a className="underline" href={settingsHref}>
              Payment settings
            </a>{' '}
            ·{' '}
            <a className="underline" href={COVERAGE_GUIDE} target="_blank" rel="noreferrer">
              Guide: payments not linked to a visit
            </a>
          </p>
        </div>
      </Modal>
    </div>
  );
}
