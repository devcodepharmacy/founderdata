import { useState, type ReactNode } from 'react';
import { api, type Coverage, type Site } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { isAppOnly } from '../../lib/siteKind';
import { Code } from '../Code';
import { COVERAGE_GUIDE, CoverageReasons, coverageStatus } from '../Coverage';
import { GumroadSetup, LemonSqueezySetup, PaddleSetup, PolarSetup } from '../PaymentProviders';
import { Callout, CopyButton, Mark, SecretField, Step, Steps } from './kit';
import { Integration } from './Integration';

export type Save = (patch: Partial<Site>, msg?: string) => Promise<void>;

/** What a refused delivery means on each card: most providers sign, Gumroad has a token, RevenueCat a header. */
const REFUSED_WHY: Record<string, string> = { gumroad: 'a wrong token or seller id', revenuecat: 'a wrong authorization header' };

/** "4 deliveries refused today for a bad signature": deliveries refused in the last 24 hours (GET /api/sites/:id). */
function refusedLine(id: string, r: { count: number; day: string } | undefined): string | null {
  if (!r) return null;
  const when = r.day === new Date().toISOString().slice(0, 10) ? 'today' : 'yesterday (UTC)';
  return `${r.count === 1 ? '1 delivery' : `${r.count} deliveries`} refused ${when} for ${REFUSED_WHY[id] ?? 'a bad signature'}`;
}

interface ProviderCard {
  id: string;
  title: string;
  mark: string;
  desc: string;
  web: boolean;
  body: ReactNode;
}

/** One card per payment provider, closed until opened, each with its state. An app's providers come first. */
export function PaymentsGroup({ site, origin, save, onKey }: { site: Site; origin: string; save: Save; onKey: (key: string) => void }) {
  // Payments in the last 30 days linked to a visit, per provider (components/Coverage.tsx). Card ids are provider ids.
  const coverage = useApi<Coverage>(`/api/sites/${site.id}/coverage?period=30d`).data;
  const covOf = (cardId: string) => coverage?.providers.find((p) => p.provider === cardId.replace('-', '_'));
  const props = { site, origin, save };
  const cards: ProviderCard[] = [
    { id: 'stripe', title: 'Stripe', mark: 'St', desc: 'Checkout, subscriptions and refunds through a signed webhook.', web: true, body: <StripeSetup {...props} /> },
    { id: 'dodo', title: 'Dodo Payments', mark: 'Do', desc: 'Payments and refunds through a signed webhook.', web: true, body: <DodoSetup {...props} /> },
    { id: 'lemonsqueezy', title: 'Lemon Squeezy', mark: 'LS', desc: 'Orders, subscriptions and refunds through a signed webhook.', web: true, body: <LemonSqueezySetup {...props} /> },
    { id: 'polar', title: 'Polar', mark: 'Po', desc: 'Orders and subscriptions through a signed webhook.', web: true, body: <PolarSetup {...props} /> },
    { id: 'paddle', title: 'Paddle', mark: 'Pa', desc: 'Transactions and adjustments through a notification destination.', web: true, body: <PaddleSetup {...props} /> },
    { id: 'gumroad', title: 'Gumroad', mark: 'Gu', desc: 'Sales through a private ping URL.', web: true, body: <GumroadSetup {...props} /> },
    { id: 'revenuecat', title: 'RevenueCat', mark: 'RC', desc: 'In-app purchases sold through RevenueCat.', web: false, body: <RevenueCatSetup {...props} /> },
    { id: 'api', title: 'Other providers (server API)', mark: 'API', desc: 'Send payments and goals from your own backend.', web: true, body: <ApiSetup site={site} origin={origin} onKey={onKey} /> },
  ];
  // For an app without a website, RevenueCat comes first.
  if (isAppOnly(site)) cards.sort((a, b) => Number(a.web) - Number(b.web));
  return (
    <div className="space-y-3">
      {cards.map((c) => {
        const refused = refusedLine(c.id, site.refused_webhooks?.[c.id.replace('-', '_')]);
        const cv = covOf(c.id);
        const cvLine = coverageStatus(cv, 30);
        return (
          <Integration key={c.id} id={c.id} site={site} mark={<Mark>{c.mark}</Mark>} title={c.title} desc={c.desc}>
            <div className="space-y-4">
              {refused && (
                <Callout tone="error">
                  {refused}. FounderData did not record the payments in them. Check that the secret below matches the one in {c.title}. Most providers retry for a
                  day or more, so a fixed secret recovers them.
                </Callout>
              )}
              {cv && cv.linked !== cv.payments && (
                <Callout tone="warn">
                  <div className="mb-1 font-medium">
                    {cv.payments - cv.linked} of {cv.payments} payments in 30 days are not linked to a visit
                  </div>
                  <CoverageReasons c={cv} />
                  <a className="mt-2 inline-block underline" href={COVERAGE_GUIDE} target="_blank" rel="noreferrer">
                    Guide: payments not linked to a visit
                  </a>
                </Callout>
              )}
              {cvLine && !(cv && cv.linked !== cv.payments) && <p className="text-[13px] text-stone-500">{cvLine}</p>}
              {c.body}
            </div>
          </Integration>
        );
      })}
    </div>
  );
}

function DodoSetup({ site, origin, save }: { site: Site; origin: string; save: Save }) {
  return (
    <Steps>
      <Step n={1} title="Add the webhook in Dodo Payments">
        Open <b>Developer, Webhooks</b>, add this endpoint and subscribe to <code>payment.succeeded</code> and <code>refund.succeeded</code>.
        <div className="mt-2">
          <Code>{`${origin}/api/webhooks/dodo/${site.id}`}</Code>
        </div>
      </Step>
      <Step n={2} title="Paste the signing secret" done={!!site.dodo_webhook_secret}>
        It starts with <code>whsec_</code>.
        <SecretField saved={site.dodo_webhook_secret} placeholder="whsec_..." onSave={(v) => save({ dodo_webhook_secret: v }, 'Webhook secret saved')} />
      </Step>
      <Step n={3} title="Send the visitor's ids with each checkout">
        This makes attribution exact. The script sets no cookies by default, so read the ids in the browser and send them with the checkout request:
        <div className="mt-2">
          <Code>{`// Browser
const rt = window.founderdata?.attribution?.() ?? {};
await fetch('/api/checkout', { method: 'POST', body: JSON.stringify({ productId: 'pdt_xxx', rt }) });

// Server
const session = await dodo.checkoutSessions.create({
  product_cart: [{ product_id: 'pdt_xxx', quantity: 1 }],
  return_url: 'https://${site.domain}/thanks',
  metadata: {
    rt_visitor_id: rt.rt_visitor_id ?? '',
    rt_session_id: rt.rt_session_id ?? '',
  },
});`}</Code>
        </div>
        <p className="mt-2 text-stone-500">
          Using Dodo <b>payment links</b> (checkout.dodopayments.com/buy/...) instead? The script adds the metadata to those links when they are clicked, but it
          doesn't always reach the payment, so also set the return URL (step 4).
        </p>
        <p className="mt-2 text-stone-500">
          Without metadata, FounderData still links the payment when the buyer lands back on your site, when their email matches a visitor you{' '}
          <code>identify()</code>, when it renews an earlier payment, or when exactly one visitor clicked a checkout link shortly before paying. The Customers tab
          shows how each payment was matched.
        </p>
      </Step>
      <Step n={4} title="Set the return URL (recommended)">
        In Dodo, set your product's return or redirect URL to a page on your site, such as <code>https://{site.domain}/thanks</code>. Dodo adds{' '}
        <code>?payment_id=...</code> to it, which links the payment to the visitor even when metadata is lost.
      </Step>
    </Steps>
  );
}

function ApiSetup({ site, origin, onKey }: { site: Site; origin: string; onKey: (key: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4 text-sm">
      <p className="text-stone-600">
        Send payments or goals from your backend with this site's API key. For an agent, make a scoped key under Agents and API instead.
      </p>
      <div>
        <div className="label">Site API key</div>
        <div className="flex gap-2">
          <input className="input min-w-0 py-1.5 font-mono text-[13px]" readOnly value={site.api_key} aria-label="Site API key" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={site.api_key} />
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={async () => {
              if (!confirm('Rotate the API key? The old key stops working immediately.')) return;
              setBusy(true);
              try {
                const r = await api<{ api_key: string }>(`/api/sites/${site.id}/rotate-key`, { method: 'POST' });
                onKey(r.api_key);
              } finally {
                setBusy(false);
              }
            }}
          >
            Rotate
          </button>
        </div>
      </div>
      <Code>{`curl -X POST ${origin}/api/v1/payments \\
  -H "Authorization: Bearer ${site.api_key}" \\
  -H "Content-Type: application/json" \\
  -d '{"transaction_id":"txn_123","amount":29.99,"currency":"${site.currency}","visitor_id":"<rt_visitor_id from attribution()>","email":"jane@example.com"}'

curl -X POST ${origin}/api/v1/goals \\
  -H "Authorization: Bearer ${site.api_key}" \\
  -H "Content-Type: application/json" \\
  -d '{"visitor_id":"<rt_visitor_id from attribution()>","name":"signup"}'`}</Code>
      <p className="text-stone-500">
        Ad, affiliate or sponsorship money: send it with <code>"kind":"income"</code>. It adds to revenue under Other revenue, and never counts as a customer or a
        conversion.
      </p>
      <Code>{`curl -X POST ${origin}/api/v1/payments \\
  -H "Authorization: Bearer ${site.api_key}" \\
  -H "Content-Type: application/json" \\
  -d '{"transaction_id":"adsense-2026-10","amount":412.50,"currency":"${site.currency}","kind":"income","product":"AdSense"}'`}</Code>
    </div>
  );
}

const STRIPE_EVENTS = [
  'checkout.session.completed',
  'invoice.paid',
  'invoice_payment.paid',
  'payment_intent.succeeded',
  'charge.succeeded',
  'charge.refunded',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.closed',
  // Subscription state for the Subscriptions tab: MRR, trials, cancellations, failed payments.
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
];

function StripeSetup({ site, origin, save }: { site: Site; origin: string; save: Save }) {
  return (
    <Steps>
      <Step n={1} title="Add the endpoint in Stripe">
        Open <b>Developers, Webhooks</b>, add an endpoint with this URL and select the {STRIPE_EVENTS.length} events below.
        <div className="mt-2 space-y-2">
          <Code>{`${origin}/api/webhooks/stripe/${site.id}`}</Code>
          <Code>{STRIPE_EVENTS.join('\n')}</Code>
        </div>
      </Step>
      <Step n={2} title="Paste the signing secret" done={!!site.stripe_webhook_secret}>
        It starts with <code>whsec_</code>.
        <SecretField saved={site.stripe_webhook_secret} placeholder="whsec_..." onSave={(v) => save({ stripe_webhook_secret: v }, 'Stripe secret saved')} />
        <label className="mt-3 flex items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-1"
            checked={site.stripe_unpinned !== 0}
            onChange={(e) => save({ stripe_unpinned: e.target.checked ? 1 : 0 }, e.target.checked ? 'Untagged Stripe payments go to this site' : 'Untagged Stripe payments skip this site')}
          />
          <span>
            Record payments that nothing ties to a site: no <code>rt_site_id</code> in the metadata, and no visitor, customer or subscription FounderData already
            knows. If several sites share one Stripe account, leave this on for one of them and off for the others, so each payment lands on one site.
          </span>
        </label>
      </Step>
      <Step n={3} title="Put the visitor's ids in the checkout's metadata">
        Read them in the browser and send them with your checkout request:
        <div className="mt-2">
          <Code>{`// Browser
const rt = window.founderdata?.attribution?.() ?? {};
await fetch('/api/checkout', { method: 'POST', body: JSON.stringify({ plan: 'pro', rt }) });

// Server
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  line_items: [{ price: 'price_xxx', quantity: 1 }],
  success_url: 'https://${site.domain}/thanks',
  metadata: rt,
  subscription_data: { metadata: rt }, // renewals keep the link; leave out for one-time payments
});`}</Code>
        </div>
        <p className="mt-2 text-stone-500">
          Without metadata, FounderData tries the customer's earlier payments and the email of a visitor you <code>identify()</code>. Refunds and lost disputes are
          subtracted from revenue. A failed or canceled refund, or a won dispute, adds the money back.
        </p>
      </Step>
      <Step n={4} title="Import past payments (optional)">
        The webhook sees payments from today on. Imports, <a className="font-medium text-ink underline underline-offset-2" href="#stripe-import">Import past Stripe payments</a>, reads the months
        before.
      </Step>
    </Steps>
  );
}

const REVENUECAT_EVENTS = [
  'INITIAL_PURCHASE, RENEWAL, NON_RENEWING_PURCHASE: revenue (a trial start is stored as a trial, not revenue)',
  'PRODUCT_CHANGE: stored as a product change, and as revenue when it carries a price',
  'CANCELLATION: stored as a cancellation; a refund (cancel reason CUSTOMER_SUPPORT) is subtracted from revenue',
  'EXPIRATION, BILLING_ISSUE: stored as signals, not money',
];

function RevenueCatSetup({ site, origin, save }: { site: Site; origin: string; save: Save }) {
  return (
    <>
      <p className="mb-4 text-sm text-stone-600">
        For apps that sell through RevenueCat. Each purchase links to the app session it came from. A purchase the app also reports through RevenueCat or App
        Store notifications is counted once.
      </p>
      <Steps>
        <Step n={1} title="Add the webhook in RevenueCat">
          Open the project, then <b>Integrations, Webhooks</b>, and add a webhook with this URL:
          <div className="mt-2">
            <Code>{`${origin}/api/webhooks/revenuecat/${site.id}`}</Code>
          </div>
        </Step>
        <Step n={2} title="Set the same secret in both places" done={!!site.revenuecat_auth}>
          Make up a long random string, set it as the webhook's <b>Authorization header value</b> in RevenueCat, and paste it here.
          <SecretField saved={site.revenuecat_auth} placeholder="at least 16 characters, no spaces" onSave={(v) => save({ revenuecat_auth: v }, 'RevenueCat secret saved')} />
        </Step>
        <Step n={3} title="Tag each purchase in the app">
          Set the subscriber attribute <code>founderDataVisitorId</code> before each purchase, so the purchase links to the session:
          <div className="mt-2">
            <Code>{`Purchases.shared.attribution.setAttributes([
  "founderDataVisitorId": FounderData.appAccountToken.uuidString.lowercased()
])`}</Code>
          </div>
          <p className="mt-2 text-stone-500">Without it, FounderData links App Store purchases through the subscription's earlier payments, and renewals through the first payment.</p>
        </Step>
      </Steps>
      <details className="mt-4 text-sm text-stone-500">
        <summary className="cursor-pointer font-medium text-stone-600 hover:text-ink">What FounderData does with each event</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {REVENUECAT_EVENTS.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <p className="mt-2">
          Amounts are the customer price in the purchase currency, before the store's commission, so the dashboard labels them gross. Sandbox events count only
          when sandbox purchases are on (App Store, App Store purchases), and never as revenue.
        </p>
      </details>
    </>
  );
}
