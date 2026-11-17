import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/shared/sources';
import { belongsTo, normalizePath } from '../src/worker/collect';
import { verifyStandardWebhook } from '../src/worker/lib/crypto';
import { bucketLabels, previousRange, quarterOf, resolveRange, startOfDay, tzOffset } from '../src/worker/lib/time';
import { isBot, parseUA } from '../src/worker/lib/ua';

describe('classify', () => {
  it('maps t.co to X / social', () => {
    expect(classify({ referrerDomain: 't.co' })).toMatchObject({ source: 'X', channel: 'Organic Social' });
  });
  it('maps Google to organic search', () => {
    expect(classify({ referrerDomain: 'google.co.in' })).toMatchObject({ source: 'Google', channel: 'Organic Search' });
  });
  it('recognises AI assistants, including utm_source=chatgpt.com', () => {
    expect(classify({ referrerDomain: null, utmSource: 'chatgpt.com' })).toMatchObject({ source: 'ChatGPT', channel: 'AI' });
  });
  it('lets ref/utm tags win over the referrer', () => {
    expect(classify({ referrerDomain: 'google.com', ref: 'producthunt' })).toMatchObject({ source: 'Product Hunt' });
    expect(classify({ referrerDomain: null, ref: 'my-newsletter-42' })).toMatchObject({ source: 'my-newsletter-42', channel: 'Referral' });
  });
  it('detects paid and email by medium', () => {
    expect(classify({ referrerDomain: 'google.com', utmMedium: 'cpc' }).channel).toBe('Paid');
    expect(classify({ referrerDomain: null, utmSource: 'buttondown', utmMedium: 'email' }).channel).toBe('Email');
  });
  it('falls back to Direct', () => {
    expect(classify({ referrerDomain: null })).toMatchObject({ source: 'Direct/None', channel: 'Direct' });
  });
  it('does not confuse mail.google.com with Google search', () => {
    expect(classify({ referrerDomain: 'mail.google.com' })).toMatchObject({ source: 'Gmail', channel: 'Email' });
  });
});

describe('user agents', () => {
  it('parses common browsers', () => {
    expect(parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'Mobile Safari', os: 'iOS', device: 'Mobile' });
    expect(parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toEqual({ browser: 'Edge', os: 'Windows', device: 'Desktop' });
    expect(parseUA('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36').browser).toBe('Chrome');
  });
  it('flags bots', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBot('Mozilla/5.0 HeadlessChrome/120')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36')).toBe(false);
  });
});

describe('domains and paths', () => {
  it('accepts subdomains only', () => {
    expect(belongsTo('app.shipkit.example.com', 'shipkit.example.com')).toBe(true);
    expect(belongsTo('www.shipkit.example.com', 'shipkit.example.com')).toBe(true);
    expect(belongsTo('evilshipkit.example.com', 'shipkit.example.com')).toBe(false);
  });
  it('normalises paths', () => {
    expect(normalizePath('/pricing/')).toBe('/pricing');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/caf%C3%A9')).toBe('/café');
  });
});

describe('time ranges', () => {
  const now = Date.UTC(2026, 9, 23, 12, 0); // 23 Oct 2026 12:00 UTC
  it('computes timezone offsets', () => {
    expect(tzOffset('Asia/Kolkata', now)).toBe(330 * 60_000);
    expect(tzOffset('UTC', now)).toBe(0);
  });
  it('starts "today" at local midnight', () => {
    const r = resolveRange({ period: 'today' }, 'Asia/Kolkata', 0, now);
    expect(r.from).toBe(Date.UTC(2026, 9, 22, 18, 30));
    expect(r.granularity).toBe('hour');
  });
  it('starts a daylight saving day at local midnight', () => {
    // 2026-10-25 began at 00:00 CEST (22:00 UTC the day before) and ended at 24:00 CET.
    expect(startOfDay(Date.UTC(2026, 9, 25, 20), 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 24, 22));
    expect(startOfDay(Date.UTC(2026, 2, 29, 20), 'Europe/Berlin')).toBe(Date.UTC(2026, 2, 28, 23));
    expect(startOfDay(Date.UTC(2026, 9, 26, 12), 'Europe/Berlin')).toBe(Date.UTC(2026, 9, 25, 23));
  });
  it('last 30 days covers 30 local days', () => {
    const r = resolveRange({ period: '30d' }, 'UTC', 0, now);
    expect(r.from).toBe(startOfDay(now, 'UTC') - 29 * 86_400_000);
    expect(bucketLabels(r, 0)).toHaveLength(30);
  });
  it('custom ranges include the whole last day', () => {
    const r = resolveRange({ period: 'custom', from: '2026-10-01', to: '2026-10-07' }, 'UTC', 0, now);
    expect(r.to - r.from).toBe(7 * 86_400_000);
  });
  it('weekly buckets start on Monday', () => {
    const r = resolveRange({ period: '30d', granularity: 'week' }, 'UTC', 0, now);
    for (const l of bucketLabels(r, 0)) expect(new Date(l + 'T00:00:00Z').getUTCDay()).toBe(1);
  });
  it('finds calendar quarters, across a year boundary', () => {
    expect(quarterOf('2026-10-30')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(quarterOf('2026-10-30', -1)).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(quarterOf('2026-02-14', -1)).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(quarterOf('2026-02-14', 1)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
  });
  it('this quarter and last quarter are calendar quarters in the viewer timezone', () => {
    // 23 Oct 2026 12:00 UTC is still Q4 in Berlin; Q3 started 1 Jul 00:00 CEST (30 Jun 22:00 UTC).
    const thisQ = resolveRange({ period: 'thisquarter' }, 'Europe/Berlin', 0, now);
    expect(thisQ).toMatchObject({ from: Date.UTC(2026, 8, 30, 22), to: now, granularity: 'day' });
    const lastQ = resolveRange({ period: 'lastquarter' }, 'Europe/Berlin', 0, now);
    expect(lastQ).toMatchObject({ from: Date.UTC(2026, 5, 30, 22), to: Date.UTC(2026, 8, 30, 22), granularity: 'day' });
    // At 23:30 UTC on 30 Sep it is already 1 Oct in Berlin, so the quarter has turned there and not in UTC.
    const turn = Date.UTC(2026, 8, 30, 23, 30);
    expect(resolveRange({ period: 'lastquarter' }, 'Europe/Berlin', 0, turn).from).toBe(Date.UTC(2026, 5, 30, 22));
    expect(resolveRange({ period: 'lastquarter' }, 'UTC', 0, turn).from).toBe(Date.UTC(2026, 3, 1));
  });
  it('compares a quarter with the quarter before, and a rolling period with the same length before', () => {
    const lastQ = resolveRange({ period: 'lastquarter' }, 'UTC', 0, now);
    expect(previousRange(lastQ, 'lastquarter', 'UTC')).toEqual({ from: Date.UTC(2026, 3, 1), to: Date.UTC(2026, 6, 1) });
    // Q1 (90 days) against all of Q4 (92 days).
    const q1 = resolveRange({ period: 'lastquarter' }, 'UTC', 0, Date.UTC(2026, 4, 2));
    expect(previousRange(q1, 'lastquarter', 'UTC')).toEqual({ from: Date.UTC(2025, 9, 1), to: Date.UTC(2026, 0, 1) });
    // This quarter so far (1 Oct to 23 Oct 12:00) against the same stretch of Q3.
    const thisQ = resolveRange({ period: 'thisquarter' }, 'UTC', 0, now);
    expect(previousRange(thisQ, 'thisquarter', 'UTC')).toEqual({ from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 6, 23, 12) });
    const d30 = resolveRange({ period: '30d' }, 'UTC', 0, now);
    expect(previousRange(d30, '30d', 'UTC')).toEqual({ from: d30.from - (d30.to - d30.from), to: d30.from });
  });
});

describe('Standard Webhooks (Dodo)', () => {
  const key = Buffer.from('super-secret-key-bytes');
  const secret = 'whsec_' + key.toString('base64');
  const body = '{"type":"payment.succeeded"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
  it('accepts a valid signature (also among several)', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body)).toBe(true);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,old v1,${sig}` }, body)).toBe(true);
  });
  it('rejects tampering and stale timestamps', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body + ' ')).toBe(false);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: String(Number(ts) - 3600), signature: `v1,${sig}` }, body)).toBe(false);
  });
});

import { propsJson } from '../src/worker/lib/props';
describe('propsJson', () => {
  it('always returns valid JSON under the limit', () => {
    const big = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, 'x'.repeat(500)]));
    const j = propsJson(big)!;
    expect(j.length).toBeLessThanOrEqual(1000);
    expect(Object.keys(JSON.parse(j)).length).toBeGreaterThan(0);
  });
  it('keeps small props as they are and drops empty ones', () => {
    expect(propsJson({ plan: 'pro', n: 2 })).toBe('{"plan":"pro","n":2}');
    expect(propsJson({})).toBeNull();
    expect(propsJson('x')).toBeNull();
  });
});
