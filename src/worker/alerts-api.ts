import { Hono } from 'hono';
import {
  ALERT_KINDS,
  allChannels,
  CHANNEL_KINDS,
  cleanAlerts,
  cleanSites,
  deliver,
  emailConfigured,
  emailTransport,
  MAX_CHANNELS,
  parseAlerts,
  publicChannel,
  readChannel,
  type AlertMessage,
  type ChannelRow,
} from './alerts';
import { requireAuth } from './auth';
import { previewMessage } from './alert-preview';
import type { AppEnv } from './env';

// ---------- dashboard API (docs/GUIDE.md, "Alerts and weekly report")

export const alerts = new Hono<AppEnv>();
alerts.use('*', requireAuth);

alerts.get('/', async (c) =>
  c.json({
    channels: (await allChannels(c.env.DB)).map(publicChannel),
    email: emailConfigured(c.env),
    // 'resend', 'cloudflare' (the EMAIL send_email binding) or null.
    email_via: emailTransport(c.env),
    kinds: CHANNEL_KINDS,
    alerts: ALERT_KINDS,
  }),
);

alerts.post('/channels', async (c) => {
  const b = await c.req.json<Record<string, unknown>>().catch(() => null);
  // Under `wrangler dev` a webhook may point at a listener on this machine over plain http.
  const host = new URL(c.req.url).hostname;
  const row = readChannel(b, c.env, Date.now(), host === 'localhost' || host === '127.0.0.1');
  if ('error' in row) return c.json({ error: row.error }, 400);
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM alert_channels').first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_CHANNELS) return c.json({ error: `A deployment has at most ${MAX_CHANNELS} channels` }, 400);
  await c.env.DB.prepare('INSERT INTO alert_channels (id, kind, name, target, secret, alerts, sites, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.kind, row.name, row.target, row.secret, row.alerts, row.sites, row.created_at)
    .run();
  return c.json(publicChannel(row));
});

const channelById = (db: D1Database, id: string) => db.prepare('SELECT * FROM alert_channels WHERE id = ?').bind(id).first<ChannelRow>();

alerts.patch('/channels/:cid', async (c) => {
  const ch = await channelById(c.env.DB, c.req.param('cid'));
  if (!ch) return c.json({ error: 'channel not found' }, 404);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const next = { ...ch };
  if (typeof b.name === 'string' && b.name.trim()) next.name = b.name.trim().slice(0, 60);
  if (b.alerts !== undefined) next.alerts = JSON.stringify(cleanAlerts(b.alerts, parseAlerts(ch.alerts)));
  const sites = cleanSites(b.sites);
  if (sites !== undefined) next.sites = sites ? JSON.stringify(sites) : null;
  await c.env.DB.prepare('UPDATE alert_channels SET name = ?, alerts = ?, sites = ? WHERE id = ?').bind(next.name, next.alerts, next.sites, ch.id).run();
  return c.json(publicChannel(next));
});

alerts.delete('/channels/:cid', async (c) => {
  await c.env.DB.prepare('DELETE FROM alert_channels WHERE id = ?').bind(c.req.param('cid')).run();
  return c.json({ ok: true });
});

/**
 * Send a test message to one channel, or with { "what": "<alert type>" } a preview of that alert (made-up numbers;
 * "weekly" is last week's real report, src/worker/alert-preview.ts). Answers with the result.
 */
alerts.post('/channels/:cid/test', async (c) => {
  const ch = await channelById(c.env.DB, c.req.param('cid'));
  if (!ch) return c.json({ error: 'channel not found' }, 404);
  const b = await c.req.json<{ what?: string }>().catch(() => ({}) as { what?: string });
  const kind = ALERT_KINDS.find((k) => k === b.what);
  const m: AlertMessage = (kind && (await previewMessage(c.env.DB, ch, kind))) || {
    kind: 'test',
    title: 'Test from FounderData',
    lines: [`This is the "${ch.name}" channel. The alerts you switch on for it arrive here.`],
  };
  return c.json(await deliver(c.env, ch, m));
});
