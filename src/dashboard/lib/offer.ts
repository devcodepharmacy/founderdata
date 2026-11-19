import { useEffect, useState } from 'react';
import { offerFromText, type Offer } from '../../shared/offer';
import { OFFER_URL, PRO_REGULAR } from '../../shared/product';

/** Loading, the live offer, or the regular price when the file can't be read or isn't valid. */
export type OfferState = { state: 'loading' } | { state: 'ready'; offer: Offer };

const REGULAR: Offer = { kind: 'regular', regular: PRO_REGULAR };

let pending: Promise<Offer> | null = null;
let known: Offer | null = null;

/** One request per page load, shared by every Pro card. A slow or failed request falls back to the regular price. */
function loadOffer(): Promise<Offer> {
  pending ??= (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(OFFER_URL, { cache: 'no-store', signal: ctrl.signal });
      return (res.ok && offerFromText(await res.text())) || REGULAR;
    } catch {
      return REGULAR;
    } finally {
      clearTimeout(timer);
    }
  })().then((o) => (known = o));
  return pending;
}

/** The launch offer for the Pro cards (components/ProUpsell.tsx). */
export function useOffer(): OfferState {
  const [offer, setOffer] = useState<Offer | null>(known);
  useEffect(() => {
    if (known) return;
    let live = true;
    loadOffer().then((o) => live && setOffer(o));
    return () => {
      live = false;
    };
  }, []);
  return offer ? { state: 'ready', offer } : { state: 'loading' };
}
