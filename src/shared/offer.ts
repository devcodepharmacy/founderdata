// The FounderData Pro launch offer (docs/PRO.md, "Price"). The dashboard reads OFFER_URL in the browser and shows the
// current step only: its price, the regular price, the licenses left at this price and the next price. Anything it
// can't trust shows the regular price with no launch claims.

/** One launch step: `seats` licenses at `price`, in minor units (499 is 4.99). */
export interface OfferTier {
  price: number;
  seats: number;
}

/** offer.json as published. `sold` counts every license sold at a launch price, across all steps. */
export interface OfferFile {
  regular: number;
  tiers: OfferTier[];
  sold: number;
  checkout?: string;
  updated?: string;
}

/** What the dashboard shows: a launch step, or the regular price once the steps are sold or there is no file. */
export type Offer =
  | {
      kind: 'launch';
      price: number;
      regular: number;
      saving: number;
      /** Licenses in this step, sold in it and left in it. */
      seats: number;
      soldInStep: number;
      leftInStep: number;
      /** The next step's price, or the regular price after the last step. */
      next: number;
      checkout?: string;
    }
  | { kind: 'regular'; regular: number; checkout?: string };

const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => count(v) && v > 0;

/**
 * offer.json, checked field by field, or null when anything is off: not an object, a price that is not a positive
 * whole number of minor units, a step at or above the regular price, steps that get cheaper, a negative count, or a
 * checkout link that is not https.
 */
export function parseOffer(data: unknown): OfferFile | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (!positive(d.regular) || !count(d.sold) || !Array.isArray(d.tiers)) return null;
  const regular = d.regular;
  const tiers: OfferTier[] = [];
  for (const t of d.tiers as unknown[]) {
    if (!t || typeof t !== 'object') return null;
    const { price, seats } = t as Record<string, unknown>;
    if (!positive(price) || !positive(seats) || price >= regular) return null;
    if (tiers.length && price < tiers[tiers.length - 1].price) return null;
    tiers.push({ price, seats });
  }
  const file: OfferFile = { regular, tiers, sold: d.sold };
  if (d.checkout !== undefined) {
    if (typeof d.checkout !== 'string' || !safeLink(d.checkout)) return null;
    file.checkout = d.checkout;
  }
  if (d.updated !== undefined) {
    if (typeof d.updated !== 'string') return null;
    file.updated = d.updated;
  }
  return file;
}

function safeLink(s: string): boolean {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The step `sold` falls in. The steps are cumulative: with 5 and 10 seats, license 6 is the first of step two. */
export function currentOffer(file: OfferFile): Offer {
  let before = 0;
  for (let i = 0; i < file.tiers.length; i++) {
    const t = file.tiers[i];
    if (file.sold < before + t.seats) {
      const soldInStep = file.sold - before;
      return {
        kind: 'launch',
        price: t.price,
        regular: file.regular,
        saving: file.regular - t.price,
        seats: t.seats,
        soldInStep,
        leftInStep: t.seats - soldInStep,
        next: file.tiers[i + 1]?.price ?? file.regular,
        checkout: file.checkout,
      };
    }
    before += t.seats;
  }
  return { kind: 'regular', regular: file.regular, checkout: file.checkout };
}

/** The offer from the text OFFER_URL answered, or null when it is not a valid offer file. */
export function offerFromText(text: string): Offer | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const file = parseOffer(data);
  return file ? currentOffer(file) : null;
}

/** 499 as "4.99". The checkout takes euros and dollars at the same number. */
export const amount = (minor: number) => (minor / 100).toFixed(2);
