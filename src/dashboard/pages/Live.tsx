import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../App';
import { Favicon, Flag } from '../components/Icons';
import { HomeLink } from '../components/Logo';
import { ThemeToggle } from '../components/ThemeToggle';
import { Segmented } from '../components/ui/Segmented';
import { LiveGlobe } from '../components/live/Globe';
import {
  ACCENT,
  LiveDot,
  LiveStyles,
  TickingNumber,
  eventAmount,
  eventVerb,
  pageLabel,
  paymentTotals,
  placeLabel,
  recentEvents,
  shortAgo,
  siteName,
  sourceLabel,
  useNow,
  usePresence,
} from '../components/live/shared';
import type { LiveData, LiveEvent, LiveSite, LiveVisitor } from '../components/live/types';
import { useLive } from '../components/live/useLive';
import { currencyDecimals, fmtMoney } from '../lib/format';

/**
 * How far back the globe glows. `now` shows only the visitors online (seen in the last 5 minutes) and the payments and
 * sign-ups of those minutes; a longer window adds a glow wherever visitors were seen in it.
 */
export type GlobeWindow = 'now' | '30m' | '1h' | '24h';
const WINDOW_MINUTES: Record<GlobeWindow, number | null> = { now: null, '30m': 30, '1h': 60, '24h': 1440 };
const WINDOW_LABEL: Record<GlobeWindow, string> = { now: 'Now', '30m': '30 min', '1h': '1 h', '24h': '24 h' };
const WINDOW_TEXT: Record<GlobeWindow, string> = { now: 'right now', '30m': 'in the last 30 minutes', '1h': 'in the last hour', '24h': 'in the last 24 hours' };
const WINDOW_KEY = 'fd_live_window';

function readWindow(): GlobeWindow {
  try {
    const v = localStorage.getItem(WINDOW_KEY);
    return v && v in WINDOW_MINUTES ? (v as GlobeWindow) : 'now';
  } catch {
    return 'now';
  }
}

/**
 * The live view at /live: who is on your sites right now, on a globe, with the count, the sites, the last hour's
 * payments and a feed of visitors. Made to stay open on a second screen: big type, no scrolling on a desktop, and
 * a fullscreen button. `?demo=1` plays the built-in demo.
 */
export function Live() {
  const [span, setSpan] = useState<GlobeWindow>(readWindow);
  useEffect(() => {
    try {
      localStorage.setItem(WINDOW_KEY, span);
    } catch {}
  }, [span]);
  const live = useLive({ placesMinutes: WINDOW_MINUTES[span] });
  const data = live.data;
  const places = span === 'now' ? NONE : data?.places ?? NONE;
  // The globe draws the events of its window: the online minutes for `now`, at most the hour the server sends.
  const events = useMemo(() => (data ? recentEvents(data.events, data.now, WINDOW_MINUTES[span] ?? data.windowMinutes) : []), [data, span]);
  const [hover, setHover] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // The tab title carries the count, so the tab says it even when another one is in front.
  useEffect(() => {
    const before = document.title;
    return () => {
      document.title = before;
    };
  }, []);
  useEffect(() => {
    if (data) document.title = `${data.online} online · FounderData`;
  }, [data?.online]);

  return (
    <div ref={root} className="flex min-h-screen flex-col bg-paper text-ink lg:h-screen lg:min-h-[640px] lg:overflow-hidden">
      <LiveStyles />
      <Header live={live} root={root} span={span} setSpan={setSpan} />
      {live.status === 'unsupported' ? (
        <Notice title="Live view needs a newer server" body="This server has no live endpoint yet. Deploy the latest FounderData, then come back here." demo />
      ) : live.status === 'error' && !data ? (
        <Notice title="Live data did not load" body="The page asks again on its own, less often after each miss." retry={live.refresh} demo />
      ) : (
        <main className="grid flex-1 grid-cols-[minmax(0,1fr)] gap-4 px-4 pb-5 sm:px-6 lg:min-h-0 lg:grid-cols-[minmax(270px,1fr)_minmax(0,2.1fr)_minmax(300px,1.15fr)] lg:grid-rows-[auto_minmax(0,1fr)] lg:gap-6 lg:px-8 lg:pb-8 lg:[grid-template-areas:'hero_globe_feed'_'side_globe_feed'] 2xl:gap-8">
          <section className="lg:[grid-area:hero]">
            <Hero data={data} loading={live.status === 'loading'} span={span} places={places.length} />
          </section>
          <section className="relative aspect-square w-full lg:aspect-auto lg:max-h-none lg:min-h-0 lg:[grid-area:globe]">
            <LiveGlobe visitors={data?.visitors ?? []} places={places} events={events} highlightId={hover} onHover={setHover} fill={0.88} />
          </section>
          <section className="flex flex-col gap-4 lg:min-h-0 lg:[grid-area:side]">
            <Sites data={data} />
            <LastHour data={data} hover={hover} setHover={setHover} />
          </section>
          <section className="flex flex-col lg:min-h-0 lg:[grid-area:feed]">
            <Feed data={data} hover={hover} setHover={setHover} />
          </section>
        </main>
      )}
    </div>
  );
}

const NONE: LiveData['places'] = [];

function Header({ live, root, span, setSpan }: { live: ReturnType<typeof useLive>; root: React.RefObject<HTMLDivElement>; span: GlobeWindow; setSpan: (w: GlobeWindow) => void }) {
  const now = useNow(1000);
  const [full, setFull] = useState(false);
  const canFull = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggle = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else root.current?.requestFullscreen().catch(() => {});
  };

  let status: React.ReactNode;
  if (live.demo) status = 'Demo data, not your sites';
  else if (live.stale) status = <span className="text-amber-700">Connection lost. Retrying.</span>;
  else if (live.updatedAt) status = `Updated ${shortAgo(now - live.updatedAt) === 'now' ? 'just now' : `${shortAgo(now - live.updatedAt)} ago`}`;

  return (
    <header className="flex h-16 shrink-0 items-center gap-2 px-4 sm:px-6 lg:h-20 lg:px-8">
      <HomeLink compact />
      <button className="btn-ghost -ml-1 hidden sm:inline-flex" onClick={() => navigate('/')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
        Home
      </button>
      <div className="ml-1 flex min-w-0 items-center gap-2.5 border-l border-stone-200 pl-3 sm:ml-2 sm:pl-4">
        <LiveDot size={9} quiet={live.status !== 'ready'} />
        <h1 className="text-[17px] font-semibold tracking-tight lg:text-[19px]">Live</h1>
        <span className="hidden truncate text-[13px] text-stone-400 sm:inline">{status}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Segmented
          label="Globe shows"
          size="sm"
          className="[&>button]:whitespace-nowrap"
          value={span}
          onChange={setSpan}
          options={(Object.keys(WINDOW_LABEL) as GlobeWindow[]).map((w) => ({
            value: w,
            label: WINDOW_LABEL[w],
            title: w === 'now' ? 'Glow only where people are online now' : `Also glow where people were ${WINDOW_TEXT[w]}`,
          }))}
        />
        {canFull && (
          <button className="btn hidden h-8 px-2.5 sm:inline-flex" onClick={toggle} aria-pressed={full} title={full ? 'Leave fullscreen (Esc)' : 'Fill the screen'}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
            </svg>
            <span className="hidden sm:inline">{full ? 'Exit fullscreen' : 'Fullscreen'}</span>
          </button>
        )}
        <ThemeToggle small />
      </div>
    </header>
  );
}

function Notice({ title, body, retry, demo }: { title: string; body: string; retry?: () => void; demo?: boolean }) {
  return (
    <main className="grid flex-1 place-items-center px-6 pb-16">
      <div className="max-w-md text-center">
        <div className="text-[22px] font-semibold tracking-tight">{title}</div>
        <p className="mt-2 text-[14px] leading-relaxed text-stone-500">{body}</p>
        <div className="mt-5 flex justify-center gap-2">
          {retry && (
            <button className="btn-dark" onClick={retry}>
              Try again
            </button>
          )}
          {demo && (
            <button className="btn" onClick={() => (window.location.href = '/live?demo=1')}>
              Watch the demo
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

const panel = 'card p-4 lg:p-5 2xl:p-6';
const heading = 'text-micro uppercase text-stone-400 2xl:text-[13px]';

function Hero({ data, loading, span, places }: { data: LiveData | null; loading: boolean; span: GlobeWindow; places: number }) {
  if (loading || !data) {
    return (
      <div aria-busy>
        <div className="fd-live-skel h-[clamp(56px,7vw,150px)] w-40 rounded-2xl bg-stone-100" />
        <div className="fd-live-skel mt-3 h-4 w-48 rounded bg-stone-100" />
      </div>
    );
  }
  const sitesOn = data.sites.filter((s) => s.online > 0).length;
  const appOn = data.visitors.filter((v) => v.platform === 'app').length;
  const customers = data.visitors.filter((v) => v.customer).length;
  return (
    <div>
      <div className="flex items-end gap-3">
        <span className="text-[clamp(64px,7.2vw,168px)] font-semibold leading-[0.85] tracking-[-0.04em]">
          <TickingNumber value={data.online} />
        </span>
      </div>
      <div className="mt-3 text-[15px] font-medium text-stone-600 lg:text-[17px] 2xl:text-[20px]">
        {data.online === 0 ? 'Nobody online right now' : data.online === 1 ? 'person online now' : 'people online now'}
      </div>
      <div className="mt-1 text-[13px] text-stone-400 2xl:text-[15px]">
        {data.online === 0
          ? span !== 'now' && places
            ? `The dim glows show where visitors were ${WINDOW_TEXT[span]}.`
            : 'A visitor shows up here about 15 seconds after opening a page.'
          : `${sitesOn === 1 ? 'On 1 site' : `Across ${sitesOn} sites`} in the last ${data.windowMinutes} minutes`}
      </div>
      {(appOn > 0 || customers > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5 text-[12px] 2xl:text-[14px]">
          {appOn > 0 && <span className="rounded-full border border-stone-200 px-2 py-0.5 text-stone-600">{appOn} in an app</span>}
          {customers > 0 && (
            <span className="rounded-full bg-revenueSoft px-2 py-0.5 font-medium text-revenue">{customers === 1 ? '1 customer' : `${customers} customers`}</span>
          )}
        </div>
      )}
    </div>
  );
}

function Sites({ data }: { data: LiveData | null }) {
  if (!data || data.sites.length === 0) return null;
  const shown = data.sites.slice(0, 8);
  const rest = data.sites.length - shown.length;
  const max = Math.max(1, ...shown.map((s) => s.online));
  return (
    <div className={panel}>
      <div className={heading}>Sites</div>
      <ul className="mt-3 space-y-2.5 2xl:space-y-3.5">
        {shown.map((s) => (
          <SiteRow key={s.id} site={s} max={max} />
        ))}
      </ul>
      {rest > 0 && <div className="mt-3 text-[12px] text-stone-400">{rest} more with nobody online</div>}
    </div>
  );
}

function SiteRow({ site, max }: { site: LiveSite; max: number }) {
  const idle = site.online === 0;
  return (
    <li className={`transition-opacity duration-500 ${idle ? 'opacity-45' : ''}`}>
      <div className="flex items-center gap-2.5">
        <Favicon domain={site.domain} size={18} />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium 2xl:text-[16px]">{site.name}</span>
        <span className="text-[16px] font-semibold tabular-nums 2xl:text-[19px]">
          <TickingNumber value={site.online} />
        </span>
      </div>
      <div className="ml-[28px] mt-1.5 h-1 overflow-hidden rounded-full bg-stone-100">
        <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${(site.online / max) * 100}%`, background: ACCENT }} />
      </div>
    </li>
  );
}

function LastHour({ data, hover, setHover }: { data: LiveData | null; hover: string | null; setHover: (id: string | null) => void }) {
  const now = useNow(5000);
  const events = data?.events ?? [];
  const rows = usePresence(events.slice(0, 12), (e) => e.key, 260);
  // Rows that arrive after the page opened flash once.
  const mounted = useRef(Date.now());
  if (!data) return null;
  const totals = paymentTotals(events);
  const count = events.filter((e) => e.kind === 'payment').length;
  return (
    <div className={`${panel} flex flex-col lg:min-h-0`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className={heading}>Last hour</div>
        {count > 0 && <div className="text-[12px] text-stone-400">{count === 1 ? '1 payment' : `${count} payments`}</div>}
      </div>
      {totals.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-x-3 text-[28px] font-semibold tracking-tight text-revenue 2xl:text-[36px]">
          {totals.map((t) => (
            <span key={t.currency} className="tabular-nums">
              <TickingNumber value={t.amount} format={(n) => fmtMoney(n, t.currency, currencyDecimals(t.currency))} />
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[13px] text-stone-400">No payments in the last hour.</div>
      )}
      {rows.length > 0 && (
        <ul className="-mx-2 mt-3 space-y-0.5 lg:min-h-0 lg:flex-1 lg:overflow-hidden lg:[mask-image:linear-gradient(to_bottom,black_80%,transparent)]">
          {rows.map(({ item: e, key, leaving }) => (
            <EventRow key={key} e={e} sites={data.sites} now={now} leaving={leaving} fresh={e.ts > mounted.current - 15_000} lit={hover === e.key} setHover={setHover} />
          ))}
        </ul>
      )}
    </div>
  );
}

function EventRow({ e, sites, now, leaving, fresh, lit, setHover }: { e: LiveEvent; sites: LiveSite[]; now: number; leaving: boolean; fresh: boolean; lit: boolean; setHover: (id: string | null) => void }) {
  const money = e.kind === 'payment';
  const site = siteName(sites, e.siteId);
  return (
    <li
      onMouseEnter={() => setHover(e.key)}
      onMouseLeave={() => setHover(null)}
      className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-colors 2xl:text-[15px] ${leaving ? 'fd-live-out' : 'fd-live-in'} ${fresh && money ? 'fd-live-flash' : ''} ${lit ? 'bg-stone-100' : ''}`}
    >
      <Flag cc={e.country} size={16} />
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <span className={`font-semibold ${money ? 'text-revenue' : 'text-ink'}`}>{money ? eventAmount(e) ?? 'Payment' : eventVerb(e)}</span>
          <span className="text-stone-500"> · {placeLabel(e)}</span>
        </div>
        {(site || (money && e.label)) && <div className="truncate text-[12px] text-stone-400 2xl:text-[13px]">{[site, money ? e.label : null].filter(Boolean).join(' · ')}</div>}
      </div>
      <span className="shrink-0 tabular-nums text-[12px] text-stone-400">{shortAgo(now - e.ts)}</span>
    </li>
  );
}

function Feed({ data, hover, setHover }: { data: LiveData | null; hover: string | null; setHover: (id: string | null) => void }) {
  const now = useNow(5000);
  const visitors = data?.visitors ?? [];
  const rows = usePresence(visitors, (v) => v.id, 260);
  return (
    <div className={`${panel} flex flex-col lg:min-h-0 lg:max-h-full`}>
      <div className="flex items-baseline justify-between gap-3">
        <div className={heading}>Visitors now</div>
        {data && data.visitors.length > 0 && <div className="text-[12px] text-stone-400">Newest first</div>}
      </div>
      {!data ? (
        <div className="mt-4 space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="fd-live-skel h-9 rounded-lg bg-stone-100" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-2 text-[13px] text-stone-400">Nobody here right now.</div>
      ) : (
        <ul className="-mx-2 mt-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1 [scrollbar-width:thin]">
          {rows.map(({ item: v, key, leaving }) => (
            <VisitorRow key={key} v={v} sites={data.sites} now={now} leaving={leaving} lit={hover === v.id} setHover={setHover} />
          ))}
        </ul>
      )}
    </div>
  );
}

const DEVICE: Record<string, string> = { desktop: 'Desktop', mobile: 'Phone', tablet: 'Tablet' };

function VisitorRow({ v, sites, now, leaving, lit, setHover }: { v: LiveVisitor; sites: LiveSite[]; now: number; leaving: boolean; lit: boolean; setHover: (id: string | null) => void }) {
  const site = sites.find((s) => s.id === v.siteId);
  const meta = [sourceLabel(v.source), v.device ? DEVICE[v.device] : v.platform === 'app' ? 'App' : null].filter(Boolean).join(' · ');
  return (
    <li
      onMouseEnter={() => setHover(v.id)}
      onMouseLeave={() => setHover(null)}
      className={`flex items-center gap-3 rounded-lg px-2 py-2 transition-colors ${leaving ? 'fd-live-out' : 'fd-live-in'} ${lit ? 'bg-stone-100' : ''}`}
    >
      <Flag cc={v.country} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-medium 2xl:text-[15px]">{placeLabel(v)}</span>
          {v.customer && <span className="shrink-0 rounded-md bg-revenueSoft px-1.5 py-px text-[10.5px] font-semibold text-revenue">Customer</span>}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-stone-400 2xl:text-[13px]">
          {site && <Favicon domain={site.domain} size={12} />}
          <span className="max-w-[62%] shrink-0 truncate font-mono text-[11.5px] text-stone-600 2xl:text-[12.5px]">{pageLabel(v)}</span>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate">{meta}</span>
        </div>
      </div>
      <span className="shrink-0 tabular-nums text-[12px] text-stone-400" title="Time on the site">
        {shortAgo(now - v.startedAt)}
      </span>
    </li>
  );
}
