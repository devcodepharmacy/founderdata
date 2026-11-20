import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, type Site } from '../lib/api';
import { fmtAgo, fmtDateTime } from '../lib/format';
import { Code } from './Code';
import { CopyButton, CopyField, InlineError, SettingsCard } from './setup/kit';
import { SetupIcons } from './setup/icons';
import { useCardStatus, useSetup } from './setup/status';
import { InfoTip } from './InfoTip';
import { SetupRow, SkeletonRows, Spinner, StatusChip, Tabs, toast } from './ui';

/**
 * Settings, "Agents" (src/worker/keys.ts, docs/API.md "API keys", docs/MCP.md): one key per agent or script, with the
 * scopes it needs, the sites it may touch and an expiry. The secret shows once, right after it is made, with ready
 * connection snippets; it lives only in this component's state and is dropped on Done. Each row joins a key with the
 * actor of the same name: when it was last used, its last write, its calls in the last 24 hours, and the verdicts of
 * the changes it logged on this site. The legacy read keys (rtr_) are listed under them.
 */

type Scope = 'read' | 'read:revenue' | 'read:rows' | 'notes:write' | 'alerts:write' | 'payments:write' | 'seo:write' | 'aso:write' | 'research:write' | 'spend:write' | 'spend:ai' | 'spend:seo' | 'mail:read' | 'mail:write' | 'mail:templates' | 'dashboards:write';

interface ApiKey {
  id: string;
  name: string;
  hint: string;
  scopes: Scope[];
  sites: string[] | null;
  created_at: number;
  expires_at: number | null;
  expired: boolean;
  last_used_at: number | null;
  last_write_at: number | null;
  calls_24h: number;
}

interface ActorRow {
  actor: string;
  changes: number;
  better: number;
  worse: number;
  inconclusive: number;
  measuring: number;
  reviewed: number;
  /** ISO time of the actor's newest change. */
  last_change: string;
}

const SCOPES: { id: Scope; label: string; text: string }[] = [
  { id: 'read', label: 'Read', text: 'Stats, SEO, ASO, app panels and notes. No revenue.' },
  { id: 'read:revenue', label: 'Read revenue', text: 'Revenue, payments, customers and MRR too.' },
  { id: 'read:rows', label: 'Raw rows', text: 'Download sessions and events as CSV. With Read revenue also payments and subscriptions. Names and emails stay empty.' },
  { id: 'notes:write', label: 'Write notes', text: 'Add chart notes and review them.' },
  { id: 'research:write', label: 'Write research', text: 'Add findings, decisions and data bought to the research log, and track keywords.' },
  { id: 'alerts:write', label: 'Change alerts', text: 'Create, change and delete alert rules.' },
  { id: 'payments:write', label: 'Send payments', text: 'Payments, goals and erasures, like the site API key.' },
  { id: 'seo:write', label: 'Push SEO', text: 'Replace the SEO snapshot: Search Console rows and the plan. Add AI answer checks.' },
  { id: 'aso:write', label: 'Push ASO', text: 'ASO keywords, countries and competitors, plus rank snapshots and reviews.' },
  { id: 'spend:write', label: 'Send ad spend', text: 'Send spend from Google Ads, TikTok or a newsletter, as rows or a CSV. Records it, costs nothing.' },
  { id: 'spend:ai', label: 'Spend on AI checks', text: 'Add prompts and competitors to AI visibility. Each prompt costs money every day on every engine you turned on.' },
  { id: 'spend:seo', label: 'Spend on SEO', text: "Buy keyword research with your DataForSEO account, up to the site's monthly cap." },
  { id: 'mail:read', label: 'Read mail', text: 'Inbox threads, sent messages and their delivery events, with addresses and message text.' },
  { id: 'mail:write', label: 'Send mail', text: 'Send from your mail domains, reply, mark read and archive. It does not include Read mail.' },
  { id: 'mail:templates', label: 'Edit mail templates', text: 'Create, change, publish and delete the templates of your mail domains. It sends nothing.' },
  { id: 'dashboards:write', label: 'Build dashboards', text: 'Create, change and delete custom dashboards on the sites this key covers. Writes no data.' },
];
const SCOPE_LABEL = Object.fromEntries(SCOPES.map((s) => [s.id, s.label])) as Record<Scope, string>;

/** What each scope lets an agent do, in plain words, with the MCP tools it unlocks (docs/MCP.md, Tools). */
const ABILITIES: Record<Scope, { text: string; tools: string[] }> = {
  read: { text: 'Answer questions about visitors, sources, pages, search, the App Store, app funnels, ad spend and the weekly report', tools: ['get_overview', 'get_breakdown', 'get_content', 'get_seo', 'get_aso', 'get_app_funnel', 'get_weekly_report', 'list_notes', 'get_note_impact'] },
  'read:revenue': { text: 'See revenue, payments, customers, MRR and App Store proceeds, and MER and CAC across ad channels', tools: ['get_customers', 'get_subscriptions', 'get_app_store_sales', 'get_apple_search_ads', 'get_paid'] },
  'read:rows': { text: 'Download raw sessions and events, and with revenue payments and subscriptions, as CSV for its own analysis', tools: ['GET /api/v1/export/<table>'] },
  'notes:write': { text: 'Log each change it makes on the chart, then review it once the 7-day verdict is in', tools: ['add_note', 'list_notes', 'review_change'] },
  'research:write': { text: 'Record what it found, decided or paid for, so the next run reuses it, and track keywords', tools: ['add_research', 'research_keywords'] },
  'alerts:write': { text: 'Create the alert rules that wake it when a number crosses a line', tools: ['POST /api/v1/alerts/rules'] },
  'payments:write': { text: 'Send payments, goals and erasures from a backend', tools: ['POST /api/v1/payments', 'POST /api/v1/goals'] },
  'seo:write': { text: 'Push the SEO snapshot and AI answer checks from a script', tools: ['PUT /api/sites/SITE_ID/seo/<part>'] },
  'aso:write': { text: 'Push App Store keywords, rank snapshots and reviews from a script', tools: ['POST /api/sites/SITE_ID/aso/snapshot'] },
  'spend:write': { text: 'Send ad spend from channels without an import, such as the Google Ads Script in the guide', tools: ['POST /api/v1/spend'] },
  'spend:ai': { text: 'Add AI visibility prompts, each billed every day on every engine you turned on', tools: ['add_ai_prompts'] },
  'spend:seo': { text: "Buy keyword research with your DataForSEO account, up to the site's monthly cap", tools: ['research_keywords'] },
  'mail:read': { text: 'Read the inbox and the sent log, with addresses and message text', tools: ['mail'] },
  'mail:write': { text: 'Send and reply from your mail domains, as an app through the Resend-compatible API or as an agent', tools: ['mail', 'POST /api/mail/emails'] },
  'mail:templates': { text: 'Upload and publish the HTML your apps send, from a build or an agent', tools: ['mail', 'POST /api/mail/templates'] },
  'dashboards:write': { text: 'Build custom dashboards of charts, numbers and tables that stay live', tools: ['dashboards', 'POST /api/v1/dashboards'] },
};

type PresetId = 'read' | 'revenue' | 'growth' | 'custom';
const PRESETS: { id: PresetId; label: string; text: string; scopes: Scope[] }[] = [
  { id: 'read', label: 'Read only', text: 'Reads every number except money. Changes nothing.', scopes: ['read'] },
  { id: 'revenue', label: 'Read with revenue', text: 'Also sees revenue, customers and MRR. Changes nothing.', scopes: ['read', 'read:revenue'] },
  { id: 'growth', label: 'Growth agent', text: 'Reads everything, logs its changes and keeps a research log. Spends nothing.', scopes: ['read', 'read:revenue', 'notes:write', 'research:write'] },
  { id: 'custom', label: 'Custom', text: 'Pick each scope yourself, including the ones that spend money.', scopes: [] },
];

const EXPIRY = [
  { days: 0, label: 'Never expires' },
  { days: 30, label: 'Expires in 30 days' },
  { days: 90, label: 'Expires in 90 days' },
  { days: 365, label: 'Expires in 1 year' },
];

/** Scopes that write get the amber tint, so a key that can change things stands out. */
const writes = (s: Scope) => s.endsWith(':write') || s.startsWith('spend:');

function ScopeChip({ scope }: { scope: Scope }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        writes(scope) ? 'bg-amber-50 text-amber-700 ring-amber-200' : 'bg-stone-100 text-stone-600 ring-stone-200'
      }`}
    >
      {SCOPE_LABEL[scope]}
    </span>
  );
}

/** What a key with these scopes can do, and what it can't, in plain words. */
function Abilities({ scopes, allSites }: { scopes: Scope[]; allSites: boolean }) {
  const order = SCOPES.map((s) => s.id).filter((s) => scopes.includes(s));
  return (
    <div className="text-[13px]">
      <ul className="space-y-2">
        <li className="flex gap-2.5">
          <Tick ok />
          <span className="text-stone-600">
            Tell the agent what it may do and how each number is computed <Tools names={['whoami', 'get_definitions']} />
          </span>
        </li>
        {order.map((s) => (
          <li key={s} className="flex gap-2.5">
            <Tick ok warn={writes(s)} />
            <span className="text-stone-600">
              {ABILITIES[s].text} <Tools names={ABILITIES[s].tools} />
            </span>
          </li>
        ))}
        {allSites && scopes.includes('read') && (
          <li className="flex gap-2.5">
            <Tick ok />
            <span className="text-stone-600">
              Compare every site side by side <Tools names={['get_portfolio']} />
            </span>
          </li>
        )}
        {scopes.includes('read') && !scopes.includes('read:revenue') && (
          <li className="flex gap-2.5">
            <Tick ok={false} />
            <span className="text-stone-500">Sees no money: revenue fields are left out of every answer</span>
          </li>
        )}
        {!scopes.includes('payments:write') && (
          <li className="flex gap-2.5">
            <Tick ok={false} />
            <span className="text-stone-500">Can't add payments, so a leaked key can't fake revenue</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function Tick({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return (
    <span
      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${ok ? (warn ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700') : 'bg-stone-100 text-stone-400'}`}
      aria-hidden="true"
    >
      <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {ok ? <path d="m2.5 6.5 2.5 2.5 4.5-6" /> : <path d="M3 6h6" />}
      </svg>
    </span>
  );
}

function Tools({ names }: { names: string[] }) {
  return (
    <span className="mt-0.5 flex flex-wrap gap-1">
      {names.map((n) => (
        <code key={n} className="rounded bg-stone-100 px-1 py-px font-mono text-[11px] text-stone-500">
          {n}
        </code>
      ))}
    </span>
  );
}

/** "3 minutes ago", or "Never". */
const ago = (ts: number | null) => (ts ? `${fmtAgo(Date.now() - ts)} ago` : 'Never');

function CreateForm({
  site,
  sites,
  onCreated,
  onCancel,
}: {
  site: Site;
  sites: { id: string; name: string }[];
  onCreated: (k: ApiKey & { key: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<PresetId>('read');
  const [scopes, setScopes] = useState<Scope[]>(['read']);
  const [reach, setReach] = useState<'this' | 'all' | 'some'>('this');
  const [picked, setPicked] = useState<string[]>([site.id]);
  const [days, setDays] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const ids = { name: useId(), sites: useId(), expiry: useId() };
  useEffect(() => first.current?.focus(), []);
  const choose = (p: PresetId) => {
    setPreset(p);
    if (p !== 'custom') setScopes(PRESETS.find((x) => x.id === p)!.scopes);
  };
  // The scope list shows only under Custom, so a toggle keeps Custom picked.
  const toggle = (s: Scope) => setScopes((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));

  return (
    <form
      className="space-y-5 rounded-xl border border-stone-200/80 bg-stone-50/60 p-4 sm:p-5"
      aria-label="New key"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const body = { name: name.trim(), scopes, sites: reach === 'all' ? null : reach === 'this' ? [site.id] : picked, expires_days: days || null };
          onCreated(await api<ApiKey & { key: string }>('/api/v1/keys', { method: 'POST', json: body }));
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label className="label" htmlFor={ids.name}>
          Name the agent
        </label>
        <input ref={first} id={ids.name} className="input max-w-sm bg-white" placeholder="growth-agent" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required />
        <p className="mt-1.5 text-xs text-stone-500">Use the name it writes as the actor of its notes, and its changes show on its row.</p>
      </div>

      <fieldset>
        <legend className="label">What may it do?</legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
          {PRESETS.map((p) => (
            <label
              key={p.id}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border bg-white px-3.5 py-3 transition-[border-color,box-shadow] duration-fast ${
                preset === p.id ? 'border-focus/60 ring-[3px] ring-focus/15' : 'border-stone-200/80 hover:border-stone-300'
              }`}
            >
              <input type="radio" name="key-preset" className="mt-1" checked={preset === p.id} onChange={() => choose(p.id)} />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{p.label}</span>
                <span className="mt-0.5 block text-xs text-stone-500">{p.text}</span>
                {p.id !== 'custom' && (
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {p.scopes.map((s) => (
                      <ScopeChip key={s} scope={s} />
                    ))}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {preset === 'custom' && (
        <fieldset>
          <legend className="label">Scopes</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {SCOPES.map((s) => (
              <label
                key={s.id}
                className={`flex cursor-pointer items-start gap-2.5 rounded-xl border bg-white px-3 py-2.5 transition-colors duration-fast ${scopes.includes(s.id) ? 'border-stone-400' : 'border-stone-200/80 hover:border-stone-300'}`}
              >
                <input type="checkbox" className="mt-0.5" checked={scopes.includes(s.id)} onChange={() => toggle(s.id)} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                    {s.label} <code className="text-xs font-normal text-stone-400">{s.id}</code>
                  </span>
                  <span className="block text-xs text-stone-500">{s.text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={ids.sites}>
            Sites
          </label>
          <select id={ids.sites} className="input bg-white" value={reach} onChange={(e) => setReach(e.target.value as typeof reach)}>
            <option value="this">This site only</option>
            <option value="some">Choose sites</option>
            <option value="all">All sites, also new ones</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor={ids.expiry}>
            Expiry
          </label>
          <select id={ids.expiry} className="input bg-white" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.days} value={x.days}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {reach === 'some' && (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
          <legend className="label">Sites this key reaches</legend>
          {sites.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />
              {s.name}
            </label>
          ))}
        </fieldset>
      )}

      {scopes.length > 0 && (
        <div className="rounded-xl border border-stone-200/80 bg-white p-4">
          <div className="mb-3 text-micro uppercase text-stone-400">With this key, the agent can</div>
          <Abilities scopes={scopes} allSites={reach !== 'this' && (reach === 'all' || picked.length > 1)} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-dark" disabled={busy || !name.trim() || !scopes.length || (reach === 'some' && !picked.length)}>
          {busy ? (
            <>
              <Spinner /> Creating
            </>
          ) : (
            'Create key'
          )}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        {error && <InlineError message={error} />}
      </div>
    </form>
  );
}

type Client = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex' | 'curl';

/** Connection snippets for each client, with the key filled in. */
export function connectSnippets(origin: string, key: string, siteParam: string | null): Record<Client, { where: string; code: string }> {
  const mcp = `${origin}/mcp`;
  const q = siteParam ? `&site=${siteParam}` : '';
  return {
    'claude-code': { where: 'Run this in a terminal. The server is then available in every Claude Code session.', code: `claude mcp add --transport http founderdata ${mcp} --header "Authorization: Bearer ${key}"` },
    'claude-desktop': {
      where: 'In Claude Desktop, open Settings, Developer, Edit Config, add this to claude_desktop_config.json and restart the app. It needs Node for npx.',
      code: JSON.stringify(
        { mcpServers: { founderdata: { command: 'npx', args: ['mcp-remote', mcp, '--header', 'Authorization:${FOUNDERDATA_KEY}'], env: { FOUNDERDATA_KEY: `Bearer ${key}` } } } },
        null,
        2,
      ),
    },
    cursor: {
      where: 'Cursor reads ~/.cursor/mcp.json. Any client that speaks Streamable HTTP and can send a header takes the same two values.',
      code: JSON.stringify({ mcpServers: { founderdata: { url: mcp, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
    },
    codex: {
      where: "Add this to Codex's config.toml, then set FOUNDERDATA_KEY in the shell that starts Codex.",
      code: `[mcp_servers.founderdata]\nurl = "${mcp}"\nbearer_token_env_var = "FOUNDERDATA_KEY"\n\n# in your shell profile\nexport FOUNDERDATA_KEY="${key}"`,
    },
    curl: {
      where: 'The REST API takes the same key. whoami answers what the key may do; the second call reads the last 7 days.',
      code: `curl -s "${origin}/api/v1/whoami" -H "Authorization: Bearer ${key}"\n\ncurl -s "${origin}/api/v1/stats/overview?period=7d${q}" -H "Authorization: Bearer ${key}"`,
    },
  };
}

const CLIENTS: { value: Client; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'claude-desktop', label: 'Claude Desktop' },
  { value: 'cursor', label: 'Cursor and others' },
  { value: 'codex', label: 'Codex' },
  { value: 'curl', label: 'REST API' },
];

/** The new key, shown once, with a ready snippet per client. */
function NewKey({ made, site, onDone }: { made: ApiKey & { key: string }; site: Site; onDone: () => void }) {
  const [client, setClient] = useState<Client>('claude-code');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const siteParam = made.sites && made.sites.length === 1 ? null : site.id;
  const snip = connectSnippets(window.location.origin, made.key, siteParam)[client];
  return (
    <div className="space-y-4 rounded-xl border border-emerald-200/70 bg-emerald-50/50 p-4 sm:p-5 animate-fade">
      <div>
        <h4 ref={heading} tabIndex={-1} className="text-[15px] font-semibold text-ink outline-none">
          {made.name} is ready. Copy the key now.
        </h4>
        <p className="mt-0.5 text-[13px] text-stone-500">Shown once. FounderData keeps only a hash, so a lost key is replaced, not recovered.</p>
      </div>
      <CopyField label="Key" value={made.key} />
      <div>
        <div className="label">Connect it</div>
        <Tabs label="Client" items={CLIENTS} value={client} onChange={setClient} className="mb-2 flex-wrap" />
        <p className="mb-2 text-[13px] text-stone-600">{snip.where}</p>
        <Code>{snip.code}</Code>
      </div>
      <div className="rounded-xl bg-white p-3.5 text-[13px] ring-1 ring-inset ring-stone-200/80">
        <div className="font-medium text-ink">Then ask it something</div>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-stone-600">
          <li>Where did this week's paying customers come from, compared with last week?</li>
          <li>Which blog posts made money last month?</li>
          <li>I just changed the pricing page headline. Add a note so we can measure it next week.</li>
        </ul>
      </div>
      <button type="button" className="btn-dark" onClick={onDone}>
        Done, I saved the key
      </button>
    </div>
  );
}

/** A read key from before scoped keys (share.ts, rtr_...): it still works, and is managed here. */
interface LegacyKey {
  token: string;
  kind: 'link' | 'api' | 'all';
  label: string | null;
  show_revenue: boolean;
  created_at: number;
  expires_at: number | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "1 change, 0 better, 0 worse", plus what is still measuring or inconclusive. */
function verdictLine(a: ActorRow | undefined) {
  if (!a) return 'No changes on this site in 90 days';
  const extra = [a.inconclusive ? `${a.inconclusive} inconclusive` : null, a.measuring ? `${a.measuring} measuring` : null].filter(Boolean);
  return `${plural(a.changes, 'change')}, ${a.better} better, ${a.worse} worse${extra.length ? `, ${extra.join(', ')}` : ''}`;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-stone-400">{label}</dt>
      <dd className={`mt-0.5 truncate font-medium tabular-nums ${tone ?? ''}`}>{value}</dd>
    </div>
  );
}

/** One agent: its key (if any) and the changes it logged on this site, judged 7 days after each. */
function AgentRow({ name, k, actor, site, siteName, onRevoke }: { name: string; k: ApiKey | null; actor: ActorRow | undefined; site: Site; siteName: (id: string) => string; onRevoke: () => void }) {
  const [more, setMore] = useState(false);
  const reach = !k ? null : !k.sites ? 'All sites' : k.sites.map(siteName).join(', ');
  const verdict = verdictLine(actor);
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-stone-50 text-stone-500 ring-1 ring-inset ring-stone-200/80" aria-hidden="true">
          {SetupIcons.agents}
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{name}</span>
            {k ? (
              <code className="text-xs text-stone-400">fdk_...{k.hint}</code>
            ) : (
              <StatusChip tone="neutral" dot={false} title="Notes from the dashboard, the site API key or a key with another name">
                No key with this name
              </StatusChip>
            )}
            {k?.expired && <StatusChip tone="error">Expired</StatusChip>}
          </div>
          {k && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {k.scopes.map((s) => (
                <ScopeChip key={s} scope={s} />
              ))}
            </div>
          )}
          <p className={`mt-1.5 text-[13px] ${actor ? 'text-stone-600' : 'text-stone-400'}`}>{verdict}</p>
          {actor && actor.worse > 0 && <p className="text-[13px] text-red-700">{plural(actor.worse, 'change')} came out worse</p>}
          {k && (
            <div className="mt-1 truncate text-xs text-stone-500" title={reach ?? undefined}>
              {reach}
              {k.expires_at && !k.expired ? ` · expires ${fmtDateTime(k.expires_at, site.timezone)}` : ''}
            </div>
          )}
          {k && (
            <button type="button" className="mt-1.5 text-xs font-medium text-stone-500 underline-offset-2 hover:text-ink hover:underline" aria-expanded={more} onClick={() => setMore((m) => !m)}>
              {more ? 'Hide what it can do' : 'What it can do'}
            </button>
          )}
          {k && more && (
            <div className="mt-2 rounded-xl bg-stone-50 p-3">
              <Abilities scopes={k.scopes} allSites={!k.sites || k.sites.length > 1} />
            </div>
          )}
        </div>
        <dl className="grid w-full grid-cols-3 gap-x-4 text-xs sm:w-auto sm:grid-cols-[6.5rem_6.5rem_4.5rem] sm:text-right">
          <Stat label="Last used" value={k ? ago(k.last_used_at) : 'No key'} tone={k ? '' : 'text-stone-400'} />
          <Stat label="Last write" value={k ? ago(k.last_write_at) : actor ? `${fmtAgo(Date.now() - Date.parse(actor.last_change))} ago` : 'Never'} />
          <Stat label="Calls, 24h" value={k ? k.calls_24h.toLocaleString('en-US') : '–'} tone={k ? '' : 'text-stone-400'} />
        </dl>
        {/* The same width with or without a key, so the numbers line up from row to row. */}
        <div className="w-full text-right sm:w-16">
          {k && (
            <button className="btn-ghost h-8 hover:text-red-600" onClick={onRevoke}>
              Revoke
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** A legacy read key (rtr_...): it reads, with revenue if it shows revenue, and can't be scoped. */
function LegacyRow({ t, site, onRevoke }: { t: LegacyKey; site: Site; onRevoke: () => void }) {
  const expired = !!t.expires_at && t.expires_at < Date.now();
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t.label || 'Legacy read key'}</span>
            <code className="text-xs text-stone-400">rtr_...{t.token.slice(-4)}</code>
            {expired && <StatusChip tone="error">Expired</StatusChip>}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <ScopeChip scope="read" />
            {t.show_revenue && <ScopeChip scope="read:revenue" />}
          </div>
          <div className="mt-1 text-xs text-stone-500">
            {t.kind === 'all' ? 'All sites' : 'This site'} · created {fmtDateTime(t.created_at, site.timezone)} · reads only, no usage log
          </div>
        </div>
        <CopyButton value={t.token} className="btn h-8" />
        <button className="btn-ghost h-8 hover:text-red-600" onClick={onRevoke}>
          Revoke
        </button>
      </div>
    </li>
  );
}

/**
 * Settings, "Agents": how to connect, one row per agent joining the scoped key and the actor its notes carry (a key
 * and an actor join on the name), and under them the legacy read keys (rtr_). Self-contained: mount it as
 * <ApiKeysSection site={site} />.
 */
export function ApiKeysSection({ site }: { site: Site }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [actors, setActors] = useState<ActorRow[]>([]);
  const [legacy, setLegacy] = useState<LegacyKey[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [made, setMade] = useState<(ApiKey & { key: string }) | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const setup = useSetup();
  const status = useCardStatus('agents', site);
  const origin = window.location.origin;
  const newButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    api<ApiKey[]>('/api/v1/keys').then(
      (k) => (setKeys(k), setError(null)),
      (e) => setError((e as Error).message),
    );
    api<{ id: string; name: string }[]>('/api/sites').then((s) => setSites(s.map(({ id, name }) => ({ id, name }))), () => undefined);
  }, [n]);
  useEffect(() => {
    api<{ actors: ActorRow[] }>(`/api/sites/${site.id}/notes/actors`).then((d) => setActors(d.actors), () => setActors([]));
    Promise.all([api<LegacyKey[]>(`/api/sites/${site.id}/share`).catch(() => []), api<LegacyKey[]>('/api/read-keys').catch(() => [])]).then(([own, all]) =>
      setLegacy([...own, ...all].filter((t) => t.kind !== 'link')),
    );
  }, [site.id]);
  const names = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const siteName = (id: string) => names.get(id) ?? id;

  // Keys first, in the order they were made, each with its actor; then actors that have no key of their name.
  const rows = useMemo(() => {
    const byActor = new Map(actors.map((a) => [a.actor, a]));
    const list: { name: string; k: ApiKey | null; actor: ActorRow | undefined }[] = (keys ?? []).map((k) => ({ name: k.name, k, actor: byActor.get(k.name) }));
    const keyed = new Set((keys ?? []).map((k) => k.name));
    for (const a of actors) if (!keyed.has(a.actor)) list.push({ name: a.actor, k: null, actor: a });
    return list;
  }, [keys, actors]);

  const revoke = async (k: ApiKey) => {
    if (!confirm(`Revoke ${k.name}? Calls with it stop working within a minute.`)) return;
    try {
      await api(`/api/v1/keys/${k.id}`, { method: 'DELETE' });
      setKeys((x) => (x ?? []).filter((y) => y.id !== k.id));
      setup?.reload();
      toast(`${k.name} revoked`, 'ok');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revokeLegacy = async (t: LegacyKey) => {
    if (!confirm(`Revoke the read key${t.label ? ` ${t.label}` : ''}? It stops working within a minute.`)) return;
    try {
      await api(`${t.kind === 'all' ? '/api/read-keys' : `/api/sites/${site.id}/share`}/${t.token}`, { method: 'DELETE' });
      setLegacy((x) => x.filter((y) => y.token !== t.token));
      toast('Read key revoked', 'ok');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const worse = actors.reduce((sum, a) => sum + a.worse, 0);
  const startNew = () => {
    setMade(null);
    setCreating(true);
  };
  return (
    <SettingsCard
      id="agents"
      title="Agents"
      status={status}
      desc="Your agents read these numbers and log what they change. Each agent gets its own key with only what it needs, and you revoke it alone."
      actions={
        !creating &&
        !made && (
          <button ref={newButton} className="btn-dark" onClick={startNew}>
            New key
          </button>
        )
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <CopyField label="MCP server" value={`${origin}/mcp`} />
          <CopyField label="REST API" value={`${origin}/api/v1`} />
        </div>

        {made && (
          <NewKey
            made={made}
            site={site}
            onDone={() => {
              setMade(null);
              requestAnimationFrame(() => newButton.current?.focus());
            }}
          />
        )}
        {creating && (
          <CreateForm
            site={site}
            sites={sites}
            onCancel={() => {
              setCreating(false);
              requestAnimationFrame(() => newButton.current?.focus());
            }}
            onCreated={(k) => {
              setMade(k);
              setCreating(false);
              setKeys((x) => [...(x ?? []), k]);
              setup?.reload();
            }}
          />
        )}

        {!keys && !error && <SkeletonRows rows={2} />}
        {error && <InlineError message={error} onRetry={() => setN((x) => x + 1)} />}

        {keys && !rows.length && !creating && !made && (
          <SetupRow
            icon={SetupIcons.agents}
            title="Connect your first agent"
            action={
              <button className="btn-dark" onClick={startNew}>
                New key
              </button>
            }
          >
            Make a key and paste one command into your agent.
          </SetupRow>
        )}

        {rows.length > 0 && (
          <div>
            <p className="mb-3 flex items-center gap-1.5 text-xs text-stone-400">
              {plural(keys?.length ?? 0, 'key')} · {plural(actors.length, 'actor')} with changes in 90 days
              {worse ? ` · ${plural(worse, 'change')} came out worse` : ''}
              <InfoTip label="How agent changes are counted" className="text-stone-400">
                Changes are the notes each actor logged on {site.name} in the last 90 days, judged 7 days after each. Usage is saved at most once a minute per key. The site API
                key under Payments keeps working too. Four workflows (weekly review, log a change, SEO opportunities, ASO check) come with the server as MCP prompts.
              </InfoTip>
            </p>
            <ul className="divide-y divide-stone-200/60">
              {rows.map((r) => (
                <AgentRow key={r.k?.id ?? `actor:${r.name}`} name={r.name} k={r.k} actor={r.actor} site={site} siteName={siteName} onRevoke={() => r.k && revoke(r.k)} />
              ))}
            </ul>
          </div>
        )}

        {legacy.length > 0 && (
          <div className="border-t border-stone-200/60 pt-4">
            <h4 className="text-sm font-semibold">Legacy read keys</h4>
            <ul className="mt-3 divide-y divide-stone-200/60">
              {legacy.map((t) => (
                <LegacyRow key={t.token} t={t} site={site} onRevoke={() => revokeLegacy(t)} />
              ))}
            </ul>
          </div>
        )}

      </div>
    </SettingsCard>
  );
}
