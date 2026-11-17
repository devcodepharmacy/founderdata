import { useEffect, useState } from 'react';

/**
 * Gross or after Apple's cut, for the Apple Search Ads card and the Subscriptions tab (src/worker/commission.ts).
 * One choice for the whole dashboard, kept in localStorage, so both places show the same kind of number.
 */
export type MoneyView = 'gross' | 'net';

const KEY = 'rt_money_view';
const EVENT = 'rt-money-view';

const read = (): MoneyView => (localStorage.getItem(KEY) === 'net' ? 'net' : 'gross');

export function useMoneyView(): [MoneyView, (v: MoneyView) => void] {
  const [view, setView] = useState<MoneyView>(read);
  useEffect(() => {
    const sync = () => setView(read());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const set = (v: MoneyView) => {
    localStorage.setItem(KEY, v);
    window.dispatchEvent(new Event(EVENT));
  };
  return [view, set];
}

/** The shares the server used for the net amounts. */
export interface NetInfo {
  commission: number;
  fallback: number;
  products: { product: string; share: number }[];
}

/** "Apple's proceeds for com.app.yearly (70%), 15% commission for the rest", for footnotes. */
export function netBasis(n: NetInfo | null | undefined): string {
  if (!n) return '';
  const pct = (s: number) => `${Math.round(s * 100)}%`;
  const own = n.products.slice(0, 3).map((p) => `${p.product} keeps ${pct(p.share)}`);
  const more = n.products.length > 3 ? `, ${n.products.length - 3} more` : '';
  return own.length
    ? `From Apple's sales report: ${own.join(', ')}${more}. Other App Store products: ${n.commission}% commission.`
    : `No product in Apple's sales report yet, so App Store amounts lose the ${n.commission}% commission set in Settings.`;
}

export function MoneySwitch({ view, onChange }: { view: MoneyView; onChange: (v: MoneyView) => void }) {
  return (
    <div className="tabs" role="group" aria-label="Amounts">
      <button className={`tab ${view === 'gross' ? 'tab-active' : ''}`} onClick={() => onChange('gross')} title="What customers paid, tax included">
        Gross
      </button>
      <button className={`tab ${view === 'net' ? 'tab-active' : ''}`} onClick={() => onChange('net')} title="App Store amounts after Apple's commission">
        After Apple's cut
      </button>
    </div>
  );
}
