import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface UsageNow {
  capped: Record<string, number>;
  /** Rows all sites wrote today against the shared pool (WRITE_POOL_ROWS, 80,000 by default). */
  pool?: { rows: number; size: number; capped_at: number | null; resets_at: number };
}

// GET /api/usage once for all the badges on a page, again after a minute.
let cache: { at: number; data: Promise<UsageNow> } | null = null;
function usageNow(): Promise<UsageNow> {
  if (!cache || Date.now() - cache.at > 60_000) {
    cache = { at: Date.now(), data: api<UsageNow>('/api/usage').catch(() => ({ capped: {} })) };
  }
  return cache.data;
}
const cappedSites = () => usageNow().then((u) => u.capped);

/** "Capped" on a site's card when it reached its daily write cap today (docs/GUIDE.md, "Daily write cap"). */
export function CapBadge({ siteId }: { siteId: string }) {
  const [at, setAt] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    cappedSites().then((c) => alive && setAt(c[siteId] ?? null));
    return () => {
      alive = false;
    };
  }, [siteId]);
  if (!at) return null;
  const time = new Date(at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  return (
    <span
      className="shrink-0 rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900"
      title={`Reached its daily write cap at ${time} UTC. Events are dropped until 00:00 UTC.`}
    >
      Capped
    </span>
  );
}

/** "Rows written today: 23,400 of 80,000" under the home page's cards (docs/GUIDE.md, "Daily write cap"). */
export function WritePoolLine({ className = 'mt-2' }: { className?: string }) {
  const [pool, setPool] = useState<UsageNow['pool'] | null>(null);
  useEffect(() => {
    let alive = true;
    usageNow().then((u) => alive && setPool(u.pool ?? null));
    return () => {
      alive = false;
    };
  }, []);
  if (!pool) return null;
  const fmt = (n: number) => n.toLocaleString('en');
  return (
    <p
      className={`${className} text-xs ${pool.capped_at ? 'text-amber-700' : 'text-stone-500'}`}
      title="Rows the tracker and the apps wrote to D1 today (UTC), all sites together. Sites on the automatic write cap stop at the pool's size. It resets at 00:00 UTC."
    >
      Rows written today: {fmt(pool.rows)} of {fmt(pool.size)}
      {pool.capped_at ? '. The shared write cap is full until 00:00 UTC.' : ''}
    </p>
  );
}
