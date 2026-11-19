import { useEffect, useState, type ReactNode } from 'react';
import { PageBar } from '../components/home/PageBar';
import { CardHeader, EmptyIcons, Note, Reveal, Segmented, SetupRow, Skeleton, Spinner } from '../components/ui';
import { Disclosure, Switch } from '../components/setup/kit';
import { api, type AlertChannel, type AlertKind, type ChannelKind, type Site } from '../lib/api';
import { ProSlot } from '../components/ProSlot';

/**
 * Alert channels for the whole deployment (src/worker/alerts.ts, docs/GUIDE.md "Alerts and weekly report"): where
 * payments, quiet sites, the write cap and the Monday report go, and which sites each channel covers.
 */

const KIND_LABELS: Record<ChannelKind, string> = { slack: 'Slack', discord: 'Discord', telegram: 'Telegram', webhook: 'Webhook', email: 'Email' };

const ALERT_LABELS: { key: AlertKind; label: string; hint: string }[] = [
  { key: 'purchase', label: 'New payments', hint: 'Amount, product, source and provider, as each payment arrives' },
  { key: 'renewal', label: 'Renewals', hint: 'Subscription renewals from Stripe, the App Store and RevenueCat' },
  { key: 'refund', label: 'Refunds', hint: 'Each refund as it arrives' },
  { key: 'trial', label: 'Trials started', hint: 'App Store and RevenueCat free trials' },
  {
    key: 'payment_failed',
    label: 'Payment failed',
    hint: "When a paying subscription's renewal fails, with the customer, product and MRR at risk",
  },
  {
    key: 'canceled',
    label: 'Subscription canceled',
    hint: 'When a paying subscriber turns off auto-renew or the subscription ends, with the customer, product and MRR lost',
  },
  { key: 'daily', label: 'Worth a look', hint: 'Daily at 07:00 UTC, only when a site went quiet or its visitors doubled or halved' },
  {
    key: 'payments_stopped',
    label: 'Payments stopped arriving',
    hint: 'Daily at 07:00 UTC, when a payment provider has sent nothing for as long as 5 payments usually take (3 days at least). A product with under 8 sales in 28 days waits twice its longest gap, 14 days at least',
  },
  {
    key: 'webhook_refused',
    label: 'Webhooks refused',
    hint: 'At once, once a day per site and provider, when a payment webhook arrives with a bad signature or token',
  },
  { key: 'cap', label: 'Write cap reached', hint: 'Once a day at most, when a site stops recording events' },
  {
    key: 'aso_collector',
    label: 'ASO collector stopped',
    hint: "Daily at 07:00 UTC, once per outage, when an app's ASO collector has sent no snapshot for 36 hours",
  },
  {
    key: 'aso_review',
    label: 'Low App Store review',
    hint: 'At once, when a new written review at or below the app\'s star limit arrives (3 stars unless you change it in the ASO tab). Needs the ASO collector',
  },
  {
    key: 'numbers',
    label: 'Daily numbers',
    hint: 'Every day at 07:00 UTC, even when nothing stands out: yesterday\'s MRR and change, new and churned subscriptions, revenue, visitors and the last Stripe check, per site. Off until you tick it',
  },
  {
    key: 'plan_away',
    label: 'No plan session',
    hint: 'Daily at 07:00 UTC, once per gap, when a site\'s plan has had no session for twice its schedule. Needs a plan with a schedule',
  },
  { key: 'weekly', label: 'Weekly report', hint: 'Mondays at 07:05 UTC: revenue, MRR, visitors, ad spend, Google clicks, trials and next actions per site' },
];

function Section({ title, sub, right, children }: { title: string; sub?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <Reveal as="section" className="card">
      <CardHeader title={title} sub={sub} right={right} />
      <div className="px-5 pb-5">{children}</div>
    </Reveal>
  );
}

type Result = { ok: boolean; text: string };

function ChannelCard({ ch, sites, onChange, onRemove }: { ch: AlertChannel; sites: Site[]; onChange: (c: AlertChannel) => void; onRemove: () => void }) {
  const [busy, setBusy] = useState(false);
  // What "Send" sends: a plain test, or a preview of one alert type (made-up numbers; the weekly report and the daily numbers are real).
  const [what, setWhat] = useState<'test' | AlertKind>('test');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');

  async function patch(body: Partial<Pick<AlertChannel, 'alerts' | 'sites'>>) {
    setError('');
    try {
      onChange(await api<AlertChannel>(`/api/alerts/channels/${ch.id}`, { method: 'PATCH', json: body }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api<{ ok: boolean; status: number; error?: string }>(`/api/alerts/channels/${ch.id}/test`, { method: 'POST', json: { what } });
      setResult(
        r.ok
          ? { ok: true, text: what === 'weekly' ? "Sent last week's report." : what === 'numbers' ? "Sent yesterday's numbers." : what === 'test' ? 'Sent. Check the channel.' : 'Preview sent. Check the channel.' }
          : { ok: false, text: `${KIND_LABELS[ch.kind]} answered ${r.status || 'nothing'}${r.error ? `: ${r.error}` : ''}` },
      );
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const only = ch.sites !== null;
  return (
    <div className="card-inset p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-ink">
            <span className="rounded-md bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600">{KIND_LABELS[ch.kind]}</span>
            {ch.name}
          </div>
          <div className="mt-1 max-w-[360px] truncate font-mono text-xs text-stone-400" title={ch.kind === 'telegram' ? undefined : ch.target}>
            {ch.kind === 'telegram' ? `chat ${ch.target}, bot token saved` : ch.target}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input h-9 w-auto py-0 text-[13px]" value={what} onChange={(e) => setWhat(e.target.value as 'test' | AlertKind)} aria-label="What to send">
            <option value="test">Test message</option>
            {ALERT_LABELS.map((a) => (
              <option key={a.key} value={a.key}>
                {a.key === 'weekly' ? "Last week's report" : a.key === 'numbers' ? "Yesterday's numbers" : `Preview: ${a.label}`}
              </option>
            ))}
          </select>
          <button className="btn-ghost" disabled={busy} onClick={send} title="Previews use made-up numbers. The weekly report and the daily numbers are real: last Monday to Sunday, and yesterday.">
            {busy ? (
              <>
                <Spinner /> Sending
              </>
            ) : (
              'Send'
            )}
          </button>
          <button
            className="btn-ghost hover:text-red-600"
            onClick={() => {
              if (confirm(`Remove the ${KIND_LABELS[ch.kind]} channel "${ch.name}"?`)) onRemove();
            }}
          >
            Remove
          </button>
        </div>
      </div>
      {result && <p className={`mt-2 text-[13px] ${result.ok ? 'text-emerald-700' : 'text-red-600'}`}>{result.text}</p>}

      <Disclosure className="mt-3" summary={`Alert types, ${ALERT_LABELS.filter((a) => ch.alerts[a.key]).length} of ${ALERT_LABELS.length} on`}>
        <div className="grid gap-x-6 sm:grid-cols-2">
          {ALERT_LABELS.map((a) => (
            <div key={a.key} className="flex items-center justify-between gap-3 border-b border-stone-200/60 py-2" title={a.hint}>
              <span className="min-w-0 truncate text-[13px] text-ink">{a.label}</span>
              <Switch checked={ch.alerts[a.key]} label={a.label} onChange={(v) => patch({ alerts: { ...ch.alerts, [a.key]: v } })} />
            </div>
          ))}
        </div>
      </Disclosure>

      <div className="mt-3 text-[13px] text-stone-600">
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input type="radio" name={`sites-${ch.id}`} checked={!only} onChange={() => patch({ sites: null })} />
            All sites, including ones you add later
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`sites-${ch.id}`} checked={only} onChange={() => patch({ sites: sites.map((s) => s.id) })} />
            Only these sites
          </label>
        </div>
        {only && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded-xl border border-stone-200/60 bg-white p-3 text-[13px]">
            {sites.map((s) => (
              <label key={s.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={ch.sites!.includes(s.id)}
                  onChange={(e) => patch({ sites: e.target.checked ? [...ch.sites!, s.id] : ch.sites!.filter((id) => id !== s.id) })}
                />
                {s.name}
              </label>
            ))}
            {!sites.length && <span className="text-stone-500">No sites yet.</span>}
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}

/** One line per channel type; the full steps open under "More". */
const HELP: Record<ChannelKind, { line: string; more?: ReactNode }> = {
  slack: {
    line: 'Add an Incoming Webhook to a Slack channel and paste its URL.',
    more: (
      <p>
        In Slack, create an app at api.slack.com/apps, turn on <b>Incoming Webhooks</b>, add a webhook to the channel you want and copy its URL.
      </p>
    ),
  },
  discord: {
    line: 'Create a webhook in a Discord channel and paste its URL.',
    more: (
      <p>
        In Discord, open the channel's settings, <b>Integrations</b>, <b>Webhooks</b>, <b>New Webhook</b>, and copy the webhook URL.
      </p>
    ),
  },
  telegram: {
    line: 'Make a bot with @BotFather, then paste its token and your chat id.',
    more: (
      <p>
        Message @BotFather, send <code>/newbot</code> and copy the token. Then send your bot a message, or add it to a group, and open{' '}
        <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code>. The chat id is under <code>chat</code>, <code>id</code>.
      </p>
    ),
  },
  webhook: {
    line: 'FounderData sends a JSON POST to this URL for each alert.',
    more: (
      <p>
        The body has <code>type</code>, <code>title</code>, <code>text</code> and the alert's fields, listed in docs/GUIDE.md, Alerts and weekly report. The URL needs https,
        except <code>http://localhost</code> while you run the Worker with wrangler dev.
      </p>
    ),
  },
  email: { line: 'Alerts arrive from the ALERT_EMAIL_FROM address.' },
};

const EMAIL_HELP: Record<'resend' | 'cloudflare', { line: string; more?: ReactNode }> = {
  resend: { line: 'Alerts arrive from the ALERT_EMAIL_FROM address, sent through Resend.' },
  cloudflare: {
    line: 'Alerts arrive from the ALERT_EMAIL_FROM address, through Cloudflare Email Routing.',
    more: <p>Cloudflare delivers only to addresses verified under Email Routing, Destination addresses, in your Cloudflare account.</p>,
  },
};

function AddChannel({ email, emailVia, onAdd }: { email: boolean; emailVia: 'resend' | 'cloudflare' | null; onAdd: (c: AlertChannel) => void }) {
  const [kind, setKind] = useState<ChannelKind>('slack');
  const [target, setTarget] = useState('');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function add() {
    setError('');
    setSaving(true);
    try {
      const ch = await api<AlertChannel>('/api/alerts/channels', { method: 'POST', json: { kind, target, secret, name } });
      onAdd(ch);
      setTarget('');
      setSecret('');
      setName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const emailOff = kind === 'email' && !email;
  return (
    <div>
      <div className="max-w-full overflow-x-auto">
        <Segmented
          label="Channel type"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setError('');
          }}
          options={(Object.keys(KIND_LABELS) as ChannelKind[]).map((k) => ({
            value: k,
            label: k === 'email' && !email ? <span className="text-stone-400">{KIND_LABELS[k]}</span> : KIND_LABELS[k],
            title: k === 'email' && !email ? 'Email is not set up on this Worker' : undefined,
          }))}
        />
      </div>
      {emailOff ? (
        <Note
          className="mt-4"
          tone="warn"
          more={
            <>
              <p>Two ways to turn it on, both with the sender in the <code>ALERT_EMAIL_FROM</code> variable:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  Cloudflare Email Routing, no other account: add a <code>send_email</code> binding named <code>EMAIL</code> to wrangler.local.jsonc and deploy. It sends only
                  to addresses you verified in Cloudflare, so it fits your own inbox. About 10 minutes.
                </li>
                <li>
                  Resend: set the <code>RESEND_API_KEY</code> secret. It sends to any address but needs a domain verified in Resend. About 15 minutes.
                </li>
              </ul>
              <p>The steps are in docs/GUIDE.md, Alerts and weekly report. Slack, Discord and Telegram need only a pasted URL or token.</p>
            </>
          }
        >
          Email is not set up on this Worker.
        </Note>
      ) : (
        <>
          <Note className="mt-4" more={(kind === 'email' && emailVia ? EMAIL_HELP[emailVia] : HELP[kind]).more}>
            {(kind === 'email' && emailVia ? EMAIL_HELP[emailVia] : HELP[kind]).line}
          </Note>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {kind === 'telegram' && (
              <div>
                <label className="label">Bot token</label>
                <input className="input font-mono" type="password" placeholder="123456789:AAE..." value={secret} onChange={(e) => setSecret(e.target.value)} />
              </div>
            )}
            <div className={kind === 'telegram' ? '' : 'sm:col-span-2'}>
              <label className="label">{kind === 'telegram' ? 'Chat id' : kind === 'email' ? 'Send to' : 'Webhook URL'}</label>
              <input
                className="input font-mono"
                type={kind === 'email' ? 'email' : kind === 'telegram' ? 'text' : 'password'}
                placeholder={
                  { slack: 'https://hooks.slack.com/services/...', discord: 'https://discord.com/api/webhooks/...', telegram: '123456789', webhook: 'https://', email: 'you@example.com' }[kind]
                }
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Name (optional)</label>
              <input className="input" placeholder={`${KIND_LABELS[kind]}, #sales`} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button className="btn-dark" disabled={saving || !target.trim()} onClick={add}>
              {saving ? (
                <>
                  <Spinner /> Adding
                </>
              ) : (
                'Add channel'
              )}
            </button>
            {error && <span className="text-sm text-red-600">{error}</span>}
          </div>
          <Note className="mt-4" more={<p>A new channel gets new payments, refunds, failed payments, cancellations, worth a look, payments stopped arriving, refused webhooks, the write cap and the weekly report for every site. Daily numbers stays off until you tick it. Change that once it is added.</p>}>
            A new channel gets every alert for every site except daily numbers.
          </Note>
        </>
      )}
    </div>
  );
}

export function Notifications() {
  const [data, setData] = useState<{ channels: AlertChannel[]; email: boolean; email_via?: 'resend' | 'cloudflare' | null } | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ channels: AlertChannel[]; email: boolean; email_via?: 'resend' | 'cloudflare' | null }>('/api/alerts').then(setData, (e) => setError(e.message));
    api<Site[]>('/api/sites').then(setSites, () => undefined);
  }, []);

  const replace = (c: AlertChannel) => setData((d) => d && { ...d, channels: d.channels.map((x) => (x.id === c.id ? c : x)) });
  async function remove(id: string) {
    await api(`/api/alerts/channels/${id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    setData((d) => d && { ...d, channels: d.channels.filter((x) => x.id !== id) });
  }

  const [adding, setAdding] = useState(false);
  const channels = data?.channels ?? [];
  const showForm = !!data && (adding || !channels.length);
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-3 sm:px-6 sm:pt-4">
      <PageBar current="notifications" />
      <div className="mx-auto max-w-3xl space-y-4">
        <div className="mt-5 sm:mt-8">
          <h1 className="text-display text-ink">Notifications</h1>
          <p className="mt-1 text-[13px] text-stone-500">Where alerts and the Monday report go. These settings cover every site.</p>
        </div>

        {error && (
          <p role="alert" className="text-[13px] text-red-600">
            {error}
          </p>
        )}

        <Section
          title="Channels"
          sub="Slack, Discord, Telegram, a webhook or email."
          right={
            !!channels.length ? (
              <button className="btn" aria-expanded={showForm} onClick={() => setAdding((a) => !a)}>
                {showForm ? 'Close' : 'Add channel'}
              </button>
            ) : undefined
          }
        >
          {!data ? (
            error ? null : (
              <div className="space-y-3" role="status" aria-busy="true">
                <span className="sr-only">Loading</span>
                {[0, 1].map((i) => (
                  <div key={i} className="rounded-xl border border-stone-200/60 p-4" aria-hidden="true">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="mt-2 h-3 w-64" />
                  </div>
                ))}
              </div>
            )
          ) : channels.length ? (
            <div className="space-y-4">
              {channels.map((ch) => (
                <ChannelCard key={ch.id} ch={ch} sites={sites} onChange={replace} onRemove={() => remove(ch.id)} />
              ))}
            </div>
          ) : (
            <SetupRow icon={EmptyIcons.inbox} title="No channels yet, so nothing is sent">
              The iPhone app's payment pushes work without one.
            </SetupRow>
          )}
          {showForm && (
            <div className={channels.length ? 'mt-5 border-t border-stone-200/60 pt-5' : 'mt-4'}>
              <div className="mb-3 text-[13px] font-medium text-ink">Add a channel</div>
              <AddChannel email={!!data?.email} emailVia={data?.email_via ?? null} onAdd={(c) => (setData((d) => d && { ...d, channels: [...d.channels, c] }), setAdding(false))} />
            </div>
          )}
        </Section>

        <ProSlot name="alertRules" sites={sites} />
      </div>
    </div>
  );
}
