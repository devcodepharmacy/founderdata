import { capMessage, parseSites, paymentMessage, refusedMessage, subscriptionMessage, type AlertKind, type AlertMessage, type ChannelRow } from './alerts';
import { buildDigest, dailyMessage, digestMessage, stoppedMessage } from './digest';
import type { Site } from './env';
// Last, so every module this file needs has loaded before Pro's tree (which imports them back) does.
import { proHooks } from './pro-hooks';

/**
 * "Send test" on the Notifications page (docs/GUIDE.md, "Alerts and weekly report"): what each alert type looks like
 * on this channel, with made-up numbers on one of the channel's sites. The weekly report is last week's real one.
 * Reads the site list only; writes nothing. "Daily numbers" is the exception: it shows yesterday's real numbers.
 */

const DAY = 86_400_000;
const EXAMPLE: Site = {
  id: 'example',
  name: 'Example site',
  domain: 'example.com',
  timezone: 'UTC',
  currency: 'USD',
  api_key: '',
  dodo_webhook_secret: null,
  created_at: 0,
  app_bundle_id: null,
  accept_sandbox: 0,
  stripe_webhook_secret: null,
  stripe_unpinned: 1,
  revenuecat_auth: null,
  asc_app_id: null,
  asc_sku: null,
  write_cap_on: 1,
  write_cap: null,
};

/** The message a preview of `kind` sends on `ch`, or null for a kind this deployment does not know. */
export async function previewMessage(db: D1Database, ch: ChannelRow, kind: AlertKind, now = Date.now()): Promise<AlertMessage | null> {
  if (kind === 'weekly') return digestMessage(await buildDigest(db, now), parseSites(ch.sites));
  const only = parseSites(ch.sites);
  // "Daily numbers" is Pro's and needs no site, so the site list stays unread for it.
  if (kind === 'numbers') {
    const n = await proHooks()?.digest?.preview?.({ db, ch, kind, site: EXAMPLE, only, now });
    return n ? { ...n, title: `Preview: ${n.title}`, data: { ...n.data, preview: true } } : null;
  }
  const sites = (await db.prepare('SELECT * FROM sites ORDER BY created_at').all<Site>()).results;
  const site = sites.find((s) => !only || only.includes(s.id)) ?? EXAMPLE;
  // Pro's kinds (ASO collector, ASO review) come from its hook; undefined means the kind is core's.
  const m = (await proHooks()?.digest?.preview?.({ db, ch, kind, site, only, now })) ?? sample(site, kind, now);
  if (!m) return null;
  return { ...m, title: `Preview: ${m.title}`, data: { ...m.data, preview: true } };
}

function sample(site: Site, kind: AlertKind, now: number): AlertMessage | null {
  // 29.00 in the site's currency (2,900 in one without decimals).
  const amount = 2900;
  switch (kind) {
    case 'purchase':
    case 'renewal':
    case 'refund':
    case 'trial':
      return paymentMessage(
        site,
        { event: kind, id: 'preview', provider: 'stripe', sandbox: false, amount: kind === 'refund' ? -amount : amount, currency: site.currency, product: 'Pro plan' },
        { source: 'Google', channel: 'Organic Search' },
      );
    case 'payment_failed':
    case 'canceled':
      return subscriptionMessage(
        site,
        kind,
        {
          id: 'preview',
          provider: 'stripe',
          product: 'Pro plan',
          customer_id: 'cus_preview',
          mrr: amount,
          expires_at: now + 12 * DAY,
          ended_at: null,
          channel: 'Organic Search',
          source: 'Google',
          campaign: null,
        },
        { email: null, name: null },
        now,
      );
    case 'daily':
      return dailyMessage([{ siteId: site.id, kind: 'traffic_up', text: `${site.name}: 120 visitors, up from 48.`, link: 'dashboard' }]);
    case 'payments_stopped':
      return stoppedMessage([{ siteId: site.id, siteName: site.name, provider: 'stripe', last: now - 12 * DAY, usual: 12, need: 12, days: 12 }]);
    case 'webhook_refused':
      return refusedMessage(site, 'lemonsqueezy', 4, now);
    case 'cap':
      return capMessage(site, now, 5000);
    default:
      return null;
  }
}
