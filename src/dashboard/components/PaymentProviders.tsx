import { useEffect, useRef, useState } from 'react';
import { api, type Site } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { Code } from './Code';
import { InlineError, SecretField, SecretInput, Step, Steps } from './setup/kit';
import { SkeletonText, Spinner, StatusChip } from './ui';

/** Setup cards for Lemon Squeezy, Polar, Paddle and Gumroad, and the Stripe history import (Settings, Payments). */

type Save = (patch: Partial<Site>, msg?: string) => Promise<void>;
interface Props {
  site: Site;
  origin: string;
  save: Save;
}

const LEMON_EVENTS = [
  'order_created',
  'order_refunded',
  'subscription_created',
  'subscription_updated',
  'subscription_cancelled',
  'subscription_expired',
  'subscription_payment_success',
  'subscription_payment_failed',
  'subscription_payment_refunded',
];

export function LemonSqueezySetup({ site, origin, save }: Props) {
  return (
    <Steps>
      <Step n={1} title="Add the webhook in Lemon Squeezy">
        Open <b>Settings, Webhooks</b>, add a webhook with this URL and select the events below.
        <div className="mt-2">
          <Code>{`${origin}/api/webhooks/lemonsqueezy/${site.id}`}</Code>
        </div>
        <div className="mt-2">
          <Code>{LEMON_EVENTS.join('\n')}</Code>
        </div>
      </Step>
      <Step n={2} title="Set the same signing secret in both places" done={!!site.lemonsqueezy_secret}>
        Type a signing secret of 6 to 40 characters into the webhook form, and paste the same one here.
        <SecretField saved={site.lemonsqueezy_secret} placeholder="signing secret" onSave={(v) => save({ lemonsqueezy_secret: v }, 'Lemon Squeezy secret saved')} />
      </Step>
      <Step n={3} title={"Send the visitor's ids as custom data"}>
        The script adds them to checkout links on your pages as <code>checkout[custom][rt_visitor_id]</code>. If you create checkouts through the API, pass
        them yourself:
        <div className="mt-2">
          <Code>{`// Browser
const rt = window.founderdata?.attribution?.() ?? {};
await fetch('/api/checkout', { method: 'POST', body: JSON.stringify({ variantId: 123, rt }) });

// Server: POST https://api.lemonsqueezy.com/v1/checkouts
{ "data": { "type": "checkouts",
  "attributes": { "checkout_data": { "custom": rt } },
  "relationships": { ... } } }`}</Code>
        </div>
        <p className="mt-2 text-stone-500">
          Lemon Squeezy repeats the custom data on renewals. Test mode orders are ignored. Without custom data, FounderData tries the customer's
          earlier payments and the email of a visitor you <code>identify()</code>.
        </p>
      </Step>
    </Steps>
  );
}

const POLAR_EVENTS = ['order.paid', 'order.refunded', 'subscription.created', 'subscription.updated', 'subscription.canceled', 'subscription.revoked'];

export function PolarSetup({ site, origin, save }: Props) {
  return (
    <Steps>
      <Step n={1} title="Add the endpoint in Polar">
        Open <b>Settings, Webhooks</b>, add an endpoint with this URL, choose the <b>Raw</b> format and select these events.
        <div className="mt-2">
          <Code>{`${origin}/api/webhooks/polar/${site.id}`}</Code>
        </div>
        <div className="mt-2">
          <Code>{POLAR_EVENTS.join('\n')}</Code>
        </div>
      </Step>
      <Step n={2} title={"Paste the endpoint's secret"} done={!!site.polar_secret}>
        Copy it from the endpoint in Polar.
        <SecretField saved={site.polar_secret} placeholder="webhook secret" onSave={(v) => save({ polar_secret: v }, 'Polar secret saved')} />
      </Step>
      <Step n={3} title={"Put the visitor's ids in the checkout's metadata"}>
        Checkout links (<code>buy.polar.sh</code>) on your pages get{' '}
        <code>reference_id=rtv_...</code> from the script, unless the link already has its own reference id.
        <div className="mt-2">
          <Code>{`// Browser
const rt = window.founderdata?.attribution?.() ?? {};

// Server
const checkout = await polar.checkouts.create({
  products: ['PRODUCT_ID'],
  successUrl: 'https://${site.domain}/thanks',
  metadata: rt,
});`}</Code>
        </div>
        <p className="mt-2 text-stone-500">
          Polar's sandbox is a separate server with its own webhooks. Connect only your live organization, so test orders stay out of revenue.
        </p>
      </Step>
    </Steps>
  );
}

const PADDLE_EVENTS = [
  'transaction.completed',
  'adjustment.created',
  'adjustment.updated',
  'subscription.created',
  'subscription.updated',
  'subscription.canceled',
  'subscription.past_due',
];

export function PaddleSetup({ site, origin, save }: Props) {
  return (
    <Steps>
      <Step n={1} title="Add a notification destination in Paddle">
        Open <b>Developer tools, Notifications</b>, add a destination with this URL and select these events.
        <div className="mt-2">
          <Code>{`${origin}/api/webhooks/paddle/${site.id}`}</Code>
        </div>
        <div className="mt-2">
          <Code>{PADDLE_EVENTS.join('\n')}</Code>
        </div>
      </Step>
      <Step n={2} title={"Paste the destination's secret key"} done={!!site.paddle_secret}>
        It starts with <code>pdl_ntfset_</code>.
        <SecretField saved={site.paddle_secret} placeholder="pdl_ntfset_..." onSave={(v) => save({ paddle_secret: v }, 'Paddle secret saved')} />
      </Step>
      <Step n={3} title={"Pass the visitor's ids as customData"}>
        Add them when you open the checkout with Paddle.js:
        <div className="mt-2">
          <Code>{`Paddle.Checkout.open({
  items: [{ priceId: 'pri_xxx', quantity: 1 }],
  customData: window.founderdata?.attribution?.() ?? {},
});`}</Code>
        </div>
        <p className="mt-2 text-stone-500">
          A refund counts once Paddle approves it. Paddle's sandbox has its own notification destinations; connect only the live one.
        </p>
      </Step>
    </Steps>
  );
}

export function GumroadSetup({ site, origin, save }: Props) {
  const [seller, setSeller] = useState(site.gumroad_seller_id ?? '');
  const url = site.gumroad_token ? `${origin}/api/webhooks/gumroad/${site.id}/${site.gumroad_token}` : null;
  return (
    <Steps>
      <Step n={1} title="Make a ping URL for this site" done={!!site.gumroad_token}>
        Gumroad signs nothing, so the URL works like a password. Keep it out of public code.
        {url ? (
          <>
            <div className="mt-2">
              <Code>{url}</Code>
            </div>
            <div className="mt-2 flex gap-2">
              <button
                className="btn"
                onClick={() => confirm('Make a new URL? The old one stops working right away.') && save({ gumroad_new_token: true }, 'New ping URL made')}
              >
                New URL
              </button>
              <button className="btn border-red-200 text-red-600" onClick={() => confirm('Turn Gumroad off for this site?') && save({ gumroad_token: '' }, 'Gumroad turned off')}>
                Turn off
              </button>
            </div>
          </>
        ) : (
          <div className="mt-2">
            <button className="btn-dark" onClick={() => save({ gumroad_new_token: true }, 'Ping URL made')}>
              Make ping URL
            </button>
          </div>
        )}
      </Step>
      <Step n={2} title="Paste it into Gumroad">
        In Gumroad, open <b>Settings, Advanced</b> and paste the URL into <b>Ping</b>. That sends sales. For refunds and cancellations, also
        add it as a resource subscription with your Gumroad access token:
        <div className="mt-2">
          <Code>{`for r in sale refund cancellation subscription_ended; do
  curl -X PUT https://api.gumroad.com/v2/resource_subscriptions \\
    -d access_token=YOUR_TOKEN -d resource_name=$r \\
    -d post_url=${url ?? 'PING_URL'}
done`}</Code>
        </div>
        <p className="mt-2 text-stone-500">
          Each sale must name your seller id. FounderData saves it from the first sale, or you can enter it here:
        </p>
        <div className="mt-2 flex gap-2">
          <input className="input font-mono" placeholder="seller id" value={seller} onChange={(e) => setSeller(e.target.value)} />
          <button className="btn" onClick={() => save({ gumroad_seller_id: seller }, 'Seller id saved')}>
            Save
          </button>
        </div>
      </Step>
      <Step n={3} title="Nothing to change on your pages">
        The script adds the visitor's ids to <code>gumroad.com/l/...</code> links and links to your <code>*.gumroad.com</code> profile. Gumroad
        sends them back as <code>url_params</code>, so each sale links to the visit. Test purchases are ignored.
      </Step>
    </Steps>
  );
}

interface ImportState {
  /** stopped: no step for 1 hour, so the server deleted the key; posting the key again resumes. */
  status: 'none' | 'running' | 'done' | 'failed' | 'canceled' | 'stopped';
  since?: number;
  cursor_ts?: number | null;
  seen?: number;
  recorded?: number;
  skipped?: number;
  error?: string | null;
  updated_at?: number;
  progress?: number;
}

const fmtDay = (ts: number) => new Date(ts).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });

/** Stripe history import: the dashboard runs it step by step while this card is open. */
export function StripeImport({ site }: { site: Site }) {
  const [state, setState] = useState<ImportState | null>(null);
  const [key, setKey] = useState('');
  const [months, setMonths] = useState(12);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const base = `/api/sites/${site.id}/stripe-import`;

  useEffect(() => {
    alive.current = true;
    api<ImportState>(base).then(setState, () => setState({ status: 'none' }));
    return () => {
      alive.current = false;
    };
  }, [base]);

  /** Call the step route until the import stops, the card closes or a request fails twice in a row. */
  async function run(first: Promise<ImportState>) {
    setBusy(true);
    setError('');
    let failures = 0;
    try {
      let s = await first;
      setState(s);
      while (alive.current && s.status === 'running') {
        try {
          s = await api<ImportState>(`${base}/step`, { method: 'POST' });
          failures = 0;
          setState(s);
        } catch (e) {
          if (++failures >= 2) throw e;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const start = () => run(api<ImportState>(base, { method: 'POST', json: { key: key.trim(), months } })).then(() => setKey(''));
  const cancel = async () => {
    alive.current = false;
    setState(await api<ImportState>(base, { method: 'DELETE' }));
    alive.current = true;
  };

  const s = state;
  const running = s?.status === 'running';
  const pct = Math.round((s?.progress ?? 0) * 100);
  if (!s) return <SkeletonText lines={3} />;
  return (
    <div className="space-y-4 text-sm">
      <p className="text-stone-600">
        The webhook sees payments from the day you connect it. The import reads your Stripe charges from the months before and skips payments the webhook
        already stored. Imported payments have no visit, so they count under No source unless the buyer's email matches a visitor you <code>identify()</code>.
      </p>

      {s.status !== 'none' && (
        <div className="rounded-xl border border-stone-200/80 bg-stone-50 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-medium text-ink">
              <StatusChip tone={running ? 'info' : s.status === 'done' ? 'ok' : s.status === 'canceled' ? 'neutral' : 'error'}>
                {running ? 'Importing' : s.status === 'done' ? 'Done' : s.status === 'canceled' ? 'Canceled' : 'Stopped'}
              </StatusChip>
              {running && <span className="tabular-nums text-stone-500">{pct}%</span>}
            </div>
            {running && (
              <div className="flex gap-2">
                {!busy && (
                  <button className="btn-dark h-8" onClick={() => run(Promise.resolve(s))}>
                    Resume
                  </button>
                )}
                <button className="btn h-8" onClick={cancel}>
                  Cancel
                </button>
              </div>
            )}
          </div>
          {running && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-stone-200" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Import progress">
              <div className="h-full origin-left rounded-full bg-emerald-500 transition-transform duration-slow ease-out" style={{ transform: `scaleX(${pct / 100})` }} />
            </div>
          )}
          <p className="mt-2 tabular-nums text-stone-600">
            {s.recorded ?? 0} payments imported, {s.skipped ?? 0} charges skipped (already stored, not paid, or test mode)
            {s.cursor_ts ? `, back to ${fmtDay(s.cursor_ts)}` : ''}.
          </p>
          {s.error && <p className="mt-1 text-red-600">{s.error}</p>}
          {running && !busy && s.updated_at && <p className="mt-1 text-stone-500">Paused {fmtAgo(Math.max(0, Date.now() - s.updated_at))} ago. Keep this page open while it runs.</p>}
        </div>
      )}

      {!running && (
        <Steps>
          <Step n={1} title="Make a restricted key in Stripe">
            Open <b>Developers, API keys</b> and create a <b>restricted key</b> with Read access to <b>Charges</b> and <b>Invoices</b>. FounderData keeps the key only
            while the import runs, and deletes it when the import ends or after 1 hour without a step.
            {s.status === 'stopped' && ' Paste the key again to resume where it stopped.'}
          </Step>
          <Step n={2} title="Paste the key and pick how far back to go">
            <form
              className="mt-2 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                start();
              }}
            >
              <SecretInput value={key} onChange={setKey} placeholder="rk_live_..." label="Stripe restricted key" />
              {/* A stopped import resumes with its own range. */}
              {s.status !== 'stopped' && (
                <select className="input w-auto" value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="How far back">
                  {[3, 6, 12, 24, 36].map((m) => (
                    <option key={m} value={m}>
                      {m} months
                    </option>
                  ))}
                </select>
              )}
              <button className="btn-dark" disabled={busy || !key.trim()}>
                {busy ? (
                  <>
                    <Spinner /> Starting
                  </>
                ) : s.status === 'stopped' ? (
                  'Resume import'
                ) : (
                  'Start import'
                )}
              </button>
            </form>
          </Step>
          <Step n={3} title="Keep this page open">
            Each step reads 20 charges and stores up to about 4 new ones. If it stops, you can resume.
          </Step>
        </Steps>
      )}
      {error && <InlineError message={error} />}
    </div>
  );
}
