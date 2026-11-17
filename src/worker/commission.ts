import type { Site } from './env';

/**
 * Apple's cut, for the Gross / After Apple's cut switch on the Subscriptions tab and the Apple Search Ads card
 * (docs/GUIDE.md "Apple's cut"). The share of an App Store amount the developer keeps is, per product:
 *
 * - Apple's own ratio when the App Store Connect sales import has the product: developer proceeds over customer
 *   price, units sold in the last 365 days, rows where both are in one currency. It takes out the commission and the
 *   VAT Apple pays, like the payout does.
 * - otherwise 1 minus the site's commission setting (`sites.app_commission`, 15 or 30, default 15). That takes out
 *   the commission only.
 *
 * Only App Store amounts are scaled. Stripe and the other web providers stay as they are.
 */

const DAY = 86_400_000;
const LOOKBACK_DAYS = 365;
export const COMMISSIONS = [15, 30] as const;
export const DEFAULT_COMMISSION = 15;

export type MoneyView = 'gross' | 'net';
export const parseMoneyView = (v: string | undefined): MoneyView => (v === 'net' ? 'net' : 'gross');

export function commissionOf(site: Partial<Pick<Site, 'app_commission'>>): number {
  const c = Number(site.app_commission);
  return (COMMISSIONS as readonly number[]).includes(c) ? c : DEFAULT_COMMISSION;
}

export interface NetShares {
  /** The commission setting in percent. */
  commission: number;
  /** 1 minus the commission: the share for a product the report does not have. */
  fallback: number;
  /** Product id (Apple's SKU column) to proceeds over customer price, from Apple's report. */
  products: Record<string, number>;
}

/** The share kept per product: Apple's ratio when the report has the product, else the setting. */
export const shareOf = (n: NetShares, product: string | null | undefined): number => (product && n.products[product] !== undefined ? n.products[product] : n.fallback);

/** One read of asc_sales by its (site_id, report_date) index. A site without the sales import gets the setting only. */
export type ShareRow = { sku: string; kept: number; paid: number };

export async function netShares(db: D1Database, site: Pick<Site, 'id' | 'app_commission'>, now = Date.now()): Promise<NetShares> {
  const since = new Date(now - LOOKBACK_DAYS * DAY).toISOString().slice(0, 10);
  const res = await db
    .prepare(
      `SELECT sku, SUM(units * proceeds) AS kept, SUM(units * customer_price) AS paid FROM asc_sales
       WHERE site_id = ? AND report_date >= ? AND kind = 'iap' AND units > 0 AND customer_price > 0 AND proceeds >= 0
         AND sku IS NOT NULL AND proceeds_currency = customer_currency
       GROUP BY sku LIMIT 500`,
    )
    .bind(site.id, since)
    .all<ShareRow>()
    .catch(() => ({ results: [] as ShareRow[] }));
  return netSharesFrom(site, res.results);
}

/**
 * netShares for every site in one statement, for a caller that does not know its sites yet (since-yesterday.ts
 * asaPrefetch). Each site keeps its first 500 products in sku order, the rows netShares reads. With `gate` the
 * statement reads nothing unless the condition holds.
 */
export async function netSharesAll(db: D1Database, now = Date.now(), gate = '1'): Promise<Map<string, ShareRow[]>> {
  const since = new Date(now - LOOKBACK_DAYS * DAY).toISOString().slice(0, 10);
  const res = await db
    .prepare(
      `SELECT site_id, sku, SUM(units * proceeds) AS kept, SUM(units * customer_price) AS paid FROM asc_sales
       WHERE report_date >= ? AND kind = 'iap' AND units > 0 AND customer_price > 0 AND proceeds >= 0
         AND sku IS NOT NULL AND proceeds_currency = customer_currency AND ${gate}
       GROUP BY site_id, sku ORDER BY site_id, sku`,
    )
    .bind(since)
    .all<ShareRow & { site_id: string }>()
    .catch(() => ({ results: [] as (ShareRow & { site_id: string })[] }));
  const out = new Map<string, ShareRow[]>();
  for (const r of res.results) {
    const list = out.get(r.site_id) ?? [];
    if (list.length < 500) list.push(r);
    out.set(r.site_id, list);
  }
  return out;
}

export function netSharesFrom(site: Pick<Site, 'app_commission'>, rows: ShareRow[]): NetShares {
  const commission = commissionOf(site);
  const products: Record<string, number> = {};
  for (const r of rows) {
    const ratio = Number(r.paid) > 0 ? Number(r.kept) / Number(r.paid) : NaN;
    if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1) products[r.sku] = Math.round(ratio * 10_000) / 10_000;
  }
  return { commission, fallback: (100 - commission) / 100, products };
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * SQL for the share of one row: `apple` is a condition true for App Store amounts, `product` the product column.
 * Other rows get 1. The numbers and product ids are inlined; the ids come from Apple's report, quoted.
 */
export function shareSql(n: NetShares, apple: string, product: string): string {
  const known = Object.entries(n.products);
  const perProduct = known.length ? `CASE ${product} ${known.map(([p, r]) => `WHEN ${quote(p)} THEN ${r}`).join(' ')} ELSE ${n.fallback} END` : String(n.fallback);
  return `(CASE WHEN ${apple} THEN ${perProduct} ELSE 1 END)`;
}

/** What the answer says about the net amounts, for the dashboard's footnote. */
export const sharesInfo = (n: NetShares) => ({
  commission: n.commission,
  fallback: n.fallback,
  products: Object.entries(n.products)
    .map(([product, share]) => ({ product, share }))
    .sort((a, b) => a.product.localeCompare(b.product)),
});

/** PATCH /api/sites/:id with `app_commission`: 15 or 30. Returns an error message, or null. index.ts stores it. */
export function patchCommission(b: Record<string, unknown>, next: Site): string | null {
  if (b.app_commission === undefined) return null;
  const c = Number(b.app_commission);
  if (!(COMMISSIONS as readonly number[]).includes(c)) return 'Set the App Store commission to 15 or 30';
  next.app_commission = c;
  return null;
}
