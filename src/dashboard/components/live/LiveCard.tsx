import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../../App';
import { Favicon, Flag } from '../Icons';
import { LiveGlobe } from './Globe';
import { ACCENT, LiveDot, LiveStyles, TickingNumber, eventVerb, placeLabel, recentEvents, shortAgo, siteName, useNow, usePresence, visitorLine } from './shared';
import type { LiveData, LiveEvent, LiveVisitor } from './types';
import { useLive } from './useLive';

/** One line of the card's ticker: an arrival or an event, newest first. */
export type Activity = { key: string; at: number; visitor?: LiveVisitor; event?: LiveEvent };

/** Arrivals and events of the last poll, newest first. */
export function activity(data: LiveData | null, limit: number): Activity[] {
  if (!data) return [];
  const rows: Activity[] = [
    ...data.events.map((e) => ({ key: `e:${e.key}`, at: e.ts, event: e })),
    ...data.visitors.map((v) => ({ key: `v:${v.id}`, at: v.startedAt, visitor: v })),
  ];
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}

/**
 * The live card for Home: who is online now, on which sites, and the latest arrivals and payments, beside a globe.
 * About 360 px tall; it fits a full-width row or half of one. A click opens /live (keeping ?demo=1).
 */
export function LiveCard({ className = '', demo }: { className?: string; demo?: boolean }) {
  const live = useLive({ demo });
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const data = live.data;
  // The globe glows only where people are online now and where something happened in the same minutes.
  const recent = useMemo(() => (data ? recentEvents(data.events, data.now, data.windowMinutes) : []), [data]);
  const open = () => navigate(live.demo ? '/live?demo=1' : '/live');
  const H = 360;
  const wide = width >= 600;
  const xwide = width >= 900;
  const G = xwide ? H * 1.3 : wide ? Math.min(H * 1.25, width * 0.62) : H * 1.08;
  const right = xwide ? Math.min(width * 0.12, width - 420 - G) : wide ? -G * 0.1 : -G * 0.42;

  return (
    <div
      ref={box}
      role="link"
      tabIndex={0}
      aria-label="Open the live view"
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className={`card group relative cursor-pointer overflow-hidden outline-none transition hover:border-stone-300 focus-visible:ring-2 focus-visible:ring-stone-300 ${className}`}
      style={{ height: H }}
    >
      <LiveStyles />
      <div
        className="absolute transition-transform duration-700 ease-out group-hover:scale-[1.02]"
        style={{ width: G, height: G, top: (H - G) / 2 + (wide ? 8 : 40), right }}
      >
        <LiveGlobe visitors={data?.visitors ?? []} events={recent} interactive={false} labels={wide} followPayments fill={0.78} className={live.status === 'unsupported' || live.status === 'error' ? 'opacity-50' : ''} />
      </div>
      {/* Keeps the text readable where the globe runs under it. */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0"
        style={{ width: xwide ? 460 : wide ? '58%' : '100%', background: `linear-gradient(90deg, rgb(var(--white)) ${wide ? 55 : 45}%, rgb(var(--white) / ${wide ? 0 : 0.35}) 100%)` }}
      />

      <div className="relative flex h-full flex-col p-5" style={{ maxWidth: xwide ? 400 : wide ? Math.max(300, width * 0.46) : undefined }}>
        <div className="flex items-center gap-2 text-[13px] font-medium text-stone-500">
          <LiveDot quiet={live.status !== 'ready' || !data?.online} />
          Live
          {live.demo && <span className="rounded-md bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-500">Demo data</span>}
          {live.stale && <span className="text-[12px] font-normal text-amber-700">Reconnecting</span>}
        </div>
        <CardBody live={live} />
      </div>

      <span className="absolute right-4 top-4 z-10 inline-flex items-center gap-1 rounded-full border border-stone-200/80 bg-white/80 px-2.5 py-1 text-[12px] font-medium text-stone-600 backdrop-blur transition group-hover:border-stone-300 group-hover:text-ink">
        Open live view
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </span>
    </div>
  );
}

function CardBody({ live }: { live: ReturnType<typeof useLive> }) {
  const now = useNow(5000);
  const data = live.data;
  const rows = usePresence(activity(data, 3), (a) => a.key, 260);

  if (live.status === 'loading') {
    return (
      <div className="mt-4 space-y-3" aria-busy>
        <div className="fd-live-skel h-10 w-28 rounded-lg bg-stone-100" />
        <div className="fd-live-skel h-3 w-40 rounded bg-stone-100" />
        <div className="mt-6 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="fd-live-skel h-3 rounded bg-stone-100" style={{ width: `${70 - i * 12}%` }} />
          ))}
        </div>
      </div>
    );
  }
  if (live.status === 'unsupported') {
    return (
      <div className="mt-4 max-w-xs">
        <div className="text-[17px] font-semibold text-ink">Live view needs a newer server</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-stone-500">This server has no live endpoint yet. Deploy the latest FounderData to see who is on your sites right now.</p>
      </div>
    );
  }
  if (live.status === 'error' || !data) {
    return (
      <div className="mt-4 max-w-xs">
        <div className="text-[17px] font-semibold text-ink">Live data did not load</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-stone-500">The card asks again on its own, less often each time.</p>
        <button
          className="btn mt-3"
          onClick={(e) => {
            e.stopPropagation();
            live.refresh();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  const top = data.sites.filter((s) => s.online > 0).slice(0, 3);
  const max = Math.max(1, ...top.map((s) => s.online));
  return (
    <>
      {data.online > 0 ? (
        <div className="mt-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[44px] font-semibold leading-none tracking-tight text-ink">
              <TickingNumber value={data.online} />
            </span>
            <span className="text-[15px] font-medium text-stone-500">online</span>
          </div>
          <div className="mt-1.5 text-[12.5px] text-stone-400">Active in the last {data.windowMinutes} minutes</div>
        </div>
      ) : (
        <div className="mt-3">
          <div className="text-[22px] font-semibold leading-tight tracking-tight text-ink">Nobody online right now</div>
          <div className="mt-1.5 max-w-[17rem] text-[12.5px] leading-relaxed text-stone-400">
            A visitor shows up here about 15 seconds after opening a page.
          </div>
        </div>
      )}

      {top.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {top.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-[13px]">
              <Favicon domain={s.domain} size={14} />
              <span className="min-w-0 flex-1 truncate text-stone-700">{s.name}</span>
              <span className="h-1 w-14 overflow-hidden rounded-full bg-stone-100">
                <span className="block h-full rounded-full transition-all duration-700" style={{ width: `${(s.online / max) * 100}%`, background: ACCENT }} />
              </span>
              <span className="w-6 text-right font-medium tabular-nums text-ink">{s.online}</span>
            </li>
          ))}
        </ul>
      )}

      <ul className="mt-auto space-y-1 border-t border-stone-200/70 pt-3" aria-label="Latest arrivals and payments">
        {rows.length === 0 && <li className="text-[12.5px] text-stone-400">No arrivals in the last {data.windowMinutes} minutes</li>}
        {rows.map(({ item, key, leaving }) => (
          <li key={key} className={`flex h-[22px] items-center gap-2 text-[12.5px] ${leaving ? 'fd-live-out' : 'fd-live-in'}`}>
            {item.event ? (
              <>
                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-revenue" />
                <span className={`shrink-0 font-semibold ${item.event.kind === 'payment' ? 'text-revenue' : 'text-ink'}`}>{eventVerb(item.event)}</span>
                <span className="min-w-0 truncate text-stone-500">
                  {placeLabel(item.event)}
                  {siteName(data.sites, item.event.siteId) ? ` · ${siteName(data.sites, item.event.siteId)}` : ''}
                </span>
              </>
            ) : (
              <>
                <Flag cc={item.visitor!.country} size={14} />
                <span className="min-w-0 truncate text-stone-600">{visitorLine(item.visitor!)}</span>
              </>
            )}
            <span className="ml-auto shrink-0 pl-1 tabular-nums text-stone-400">{shortAgo(now - item.at)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
