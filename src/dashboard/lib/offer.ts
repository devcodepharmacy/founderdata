import { useEffect, useState } from 'react';
import { offerFromText, type Offer } from '../../shared/offer';
import { OFFER_URL, PRO_REGULAR } from '../../shared/product';

/** Loading, or the offer to show: the live one, or the price after launch when the file can't be read or isn't valid. */
export type OfferState = { state: 'loading' } | { state: 'ready'; offer: Offer };

const AFTER_LAUNCH: Offer = { kind: 'regular', regular: PRO_REGULAR };
/** Older than this, the offer loads again. The file changes on a sale, so its own `updated` time says nothing. */
const MAX_AGE = 10 * 60_000;

let known: Offer | null = null;
let loadedAt = 0;
let pending: Promise<void> | null = null;
const listeners = new Set<(o: Offer) => void>();

/**
 * One request at a time, shared by every Pro card. A slow or failed first request falls back to the price after
 * launch; a failed later one keeps the last offer it read, which was real.
 */
function load() {
  pending ??= (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let next: Offer | null = null;
    try {
      const res = await fetch(OFFER_URL, { cache: 'no-store', signal: ctrl.signal });
      next = res.ok ? offerFromText(await res.text()) : null;
    } catch {
      next = null;
    } finally {
      clearTimeout(timer);
    }
    known = next ?? known ?? AFTER_LAUNCH;
    loadedAt = Date.now();
    pending = null;
    listeners.forEach((l) => l(known!));
  })();
}

const stale = () => !known || Date.now() - loadedAt > MAX_AGE;

// While a Pro card is on screen: load again when the tab comes back, and every 10 minutes while it stays visible.
function onVisible() {
  if (document.visibilityState === 'visible') load();
}
let timer: ReturnType<typeof setInterval> | undefined;
function watch(on: boolean) {
  if (on) {
    document.addEventListener('visibilitychange', onVisible);
    timer = setInterval(() => document.visibilityState === 'visible' && stale() && load(), 60_000);
  } else {
    document.removeEventListener('visibilitychange', onVisible);
    clearInterval(timer);
  }
}

/** The launch offer for the Pro cards (components/ProUpsell.tsx, ProPaywall.tsx). */
export function useOffer(): OfferState {
  const [offer, setOffer] = useState<Offer | null>(known);
  useEffect(() => {
    listeners.add(setOffer);
    if (listeners.size === 1) watch(true);
    if (stale()) load();
    return () => {
      listeners.delete(setOffer);
      if (!listeners.size) watch(false);
    };
  }, []);
  return offer ? { state: 'ready', offer } : { state: 'loading' };
}
