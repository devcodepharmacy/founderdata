import type { Site } from './env';
import { convertPayments } from './fx';
import { randomId } from './lib/crypto';
import { announce, type Pusher } from './notify';
import { creditedSession, recordPayment, recordSignal, type SignalInput } from './payments';
import { visitorIds } from './stripe';
import { recordSubscription, subscriptionElsewhere, type SubEvent } from './subscriptions';

/**
 * What Lemon Squeezy, Polar, Paddle and Gumroad share (src/worker/lemonsqueezy.ts, polar.ts, paddle.ts, gumroad.ts):
 * their settings, the visitor ids in checkout metadata, and storing a payment, a refund or a subscription signal.
 *
 * Payment ids are global (payments.id), prefixed per provider. A store whose webhook reaches several sites stores each
 * payment once: on the site its metadata names (rt_site_id, which attribution() includes), else on the first site
 * that receives it. Refunds count only on the site that stored the payment.
 */

type Obj = Record<string, any>;
export const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);
/** An integer amount in minor units from a number or a numeric string ("1999"). */
export const minor = (v: unknown): number => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n) : 0;
};
export const time = (v: unknown): number | null => (typeof v === 'string' ? Date.parse(v) || null : null);

// ---------- settings

const SECRETS = ['lemonsqueezy_secret', 'polar_secret', 'paddle_secret'] as const;
const MASK = '••••••••';

/** The signing secrets are write-only in the dashboard API, like the Stripe and Dodo ones. */
export function maskProviderSecrets(s: Site) {
  return Object.fromEntries(SECRETS.map((k) => [k, s[k] ? MASK : null]));
}

/**
 * Apply the provider fields of a PATCH /api/sites/:id body to `next`. Returns an error message, or null.
 * Gumroad: `gumroad_new_token: true` makes the ping URL's token (a new one turns the old URL off), `gumroad_token: ""`
 * turns Gumroad off. The seller id may be typed in, or is saved from the first sale ping (gumroad.ts). The PATCH
 * handler (index.ts) stores them with the rest of the site in one UPDATE.
 */
export function patchProviderSettings(b: Record<string, unknown>, next: Site): string | null {
  for (const k of SECRETS) {
    const v = b[k];
    if (typeof v !== 'string' || v.includes('•')) continue;
    const secret = v.trim();
    if (secret && !/^[\x21-\x7e]{6,300}$/.test(secret)) return 'Paste the signing secret as it is shown, without spaces';
    next[k] = secret || null;
  }
  if (typeof b.gumroad_seller_id === 'string') {
    const seller = b.gumroad_seller_id.trim();
    if (seller && !/^[\w=-]{4,100}$/.test(seller)) return 'A Gumroad seller id has letters, digits, - and _ only';
    next.gumroad_seller_id = seller || null;
  }
  if (b.gumroad_new_token === true) next.gumroad_token = randomId(16);
  if (b.gumroad_token === '') {
    next.gumroad_token = null;
    next.gumroad_seller_id = null;
  }
  return null;
}

/** The PATCH body keys patchProviderSettings reads; the PATCH handler stores the provider columns only when one is there. */
export const PROVIDER_FIELDS: readonly string[] = [...SECRETS, 'gumroad_seller_id', 'gumroad_new_token', 'gumroad_token'];

// ---------- payments, refunds, signals

/**
 * Visitor and site ids from checkout metadata: rt_visitor_id / rt_session_id / rt_site_id (what attribution() returns,
 * or the older ml_* names), or a reference "rtv_<visitor id>" (the tracker adds that to Polar checkout links).
 */
export function metaIds(meta: unknown, reference?: unknown) {
  const m = obj(meta);
  // The short names some people type into a checkout URL by hand.
  const merged = { rt_visitor_id: m.rt_vid, rt_session_id: m.rt_sid, ...m };
  return visitorIds(merged, reference);
}

export interface ProviderPayment {
  id: string;
  provider: string;
  ts: number;
  /** Minor units, positive. */
  amount: number;
  currency: string;
  meta: ReturnType<typeof metaIds>;
  customerId?: string | null;
  email?: string | null;
  name?: string | null;
  subscriptionId?: string | null;
  product?: string | null;
  renewal?: boolean;
  /** false: never guess the buyer from checkout clicks (imports, payments long after the click). */
  timing?: boolean;
}

/** Store a provider's payment once, attributed like every other payment (payments.ts attribute()). */
export async function recordProviderPayment(db: D1Database, site: Site, p: ProviderPayment, push?: Pusher): Promise<string> {
  if (p.meta.siteId && p.meta.siteId !== site.id) return 'other site';
  if (!(p.amount > 0)) return 'nothing paid';
  const owner = await db.prepare('SELECT site_id FROM payments WHERE id = ?').bind(p.id).first<{ site_id: string }>();
  if (owner && owner.site_id !== site.id) return 'other site';
  const res = await recordPayment(
    db,
    site,
    {
      id: p.id,
      provider: p.provider,
      ts: p.ts,
      amount: p.amount,
      kind: 'payment',
      currency: p.currency,
      visitorId: p.meta.visitorId,
      sessionId: p.meta.sessionId,
      customerId: p.customerId ?? null,
      email: p.email?.toLowerCase() ?? null,
      name: p.name ?? null,
      subscriptionId: p.subscriptionId ?? null,
      product: p.product ?? null,
      renewal: p.renewal,
      timing: p.timing,
    },
    // A repeat delivery with checkout metadata can replace a guessed link, never a metadata one.
    { fillIn: true, push },
  );
  return res.inserted ? 'recorded' : 'already recorded';
}

interface StoredPayment {
  site_id: string;
  currency: string;
  visitor_id: string | null;
  session_id: string | null;
  customer_id: string | null;
  email: string | null;
  name: string | null;
  subscription_id: string | null;
  product: string | null;
  channel: string | null;
  source: string | null;
  campaign: string | null;
}

/**
 * One negative row (`rowId`) holding what is refunded of a payment now: a later, larger refund of the same payment
 * replaces the amount, 0 deletes the row. Only a new row alerts. The refund uses the payment's currency.
 */
export async function setRefund(
  db: D1Database,
  site: Site,
  r: { rowId: string; provider: string; paymentId: string; amount: number; ts: number },
  push?: Pusher,
): Promise<string> {
  const original = await db
    .prepare("SELECT * FROM payments WHERE site_id = ? AND id = ? AND kind = 'payment'")
    .bind(site.id, r.paymentId)
    .first<StoredPayment>();
  if (!original) return 'no payment';
  if (!(r.amount > 0)) {
    const del = await db.prepare("DELETE FROM payments WHERE site_id = ? AND id = ? AND kind = 'refund'").bind(site.id, r.rowId).run();
    return del.meta.changes ? 'refund reversed' : 'nothing refunded';
  }
  const seen = await db.prepare('SELECT 1 FROM payments WHERE id = ?').bind(r.rowId).first();
  await db
    .prepare(
      `INSERT INTO payments (id, site_id, provider, ts, amount, kind, currency, visitor_id, session_id, customer_id, email, name, subscription_id, product,
                             channel, source, campaign)
       VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET amount = excluded.amount, amount_conv = NULL
       WHERE payments.site_id = excluded.site_id AND payments.amount != excluded.amount`,
    )
    .bind(
      r.rowId,
      site.id,
      r.provider,
      r.ts,
      -Math.abs(r.amount),
      original.currency,
      original.visitor_id,
      original.session_id,
      original.customer_id,
      original.email,
      original.name,
      original.subscription_id,
      original.product,
      original.channel,
      original.source,
      original.campaign,
    )
    .run();
  if (original.currency !== site.currency) await convertPayments(db, fetch, { rescan: true }).catch(() => 0);
  if (seen) return 'refund updated';
  await announce(push, site, {
    event: 'refund',
    id: r.rowId,
    provider: r.provider,
    sandbox: false,
    amount: Math.abs(r.amount),
    currency: original.currency,
    product: original.product,
    sessionId: original.session_id,
  });
  return 'refund recorded';
}

/**
 * A subscription signal (trial, cancellation, expiration, billing issue). The visitor comes from the metadata, else
 * from a stored payment of the same subscription or customer.
 */
export async function providerSignal(
  db: D1Database,
  site: Site,
  g: Omit<SignalInput, 'visitorId' | 'sessionId'> & { meta: ReturnType<typeof metaIds>; subscriptionId?: string | null; customerId?: string | null },
  push?: Pusher,
): Promise<string> {
  if (g.meta.siteId && g.meta.siteId !== site.id) return 'other site';
  let visitorId = g.meta.visitorId;
  if (!visitorId && (g.subscriptionId || g.customerId)) {
    const row = await db
      .prepare(
        `SELECT visitor_id FROM payments WHERE site_id = ? AND visitor_id IS NOT NULL
           AND ((subscription_id IS NOT NULL AND subscription_id = ?) OR (customer_id IS NOT NULL AND customer_id = ?))
         ORDER BY ts LIMIT 1`,
      )
      .bind(site.id, g.subscriptionId ?? null, g.customerId ?? null)
      .first<{ visitor_id: string }>();
    visitorId = row?.visitor_id ?? null;
  }
  const sessionId = visitorId ? ((await creditedSession(db, site, visitorId, g.ts)) ?? g.meta.sessionId) : null;
  const { meta: _m, subscriptionId: _s, customerId: _c, ...signal } = g;
  await recordSignal(db, site, { ...signal, visitorId, sessionId }, push);
  return g.type;
}

/**
 * Fold a subscription event into the subscriptions table (src/worker/subscriptions.ts), which the Subscriptions tab
 * and MRR read. A subscription another site holds, or whose metadata names another site, stays there.
 */
export async function providerSubscription(db: D1Database, site: Site, ev: SubEvent, meta: ReturnType<typeof metaIds>): Promise<void> {
  if (!ev.id || (meta.siteId && meta.siteId !== site.id)) return;
  if (await subscriptionElsewhere(db, site, ev.id)) return;
  await recordSubscription(db, site, { ...ev, visitorId: ev.visitorId ?? meta.visitorId, sessionId: ev.sessionId ?? meta.sessionId });
}

/** "2026-11-02": signals without an event id of their own are stored once per subscription, type and day. */
export const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
