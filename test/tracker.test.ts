// Runs public/js/script.js in a VM with a minimal fake browser: a cookie jar, fetch, sendBeacon, storage.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const CODE = fs.readFileSync(path.resolve(__dirname, '../public/js/script.js'), 'utf8');
// What the build serves (vite.config.ts minifyTracker): the same file, minified by esbuild.
const MINIFIED = transformSync(CODE, { minify: true, legalComments: 'inline', target: 'es2017' }).code;
const SERVER_IDS = { vid: '0123456789abcdef0123456789abcdef', sid: 'fedcba9876543210fedcba9876543210' };
const att = (vid: string, sid: string, site = 'site123') => ({
  rt_visitor_id: vid,
  rt_session_id: sid,
  rt_site_id: site,
  ml_visitor_id: vid,
  ml_session_id: sid,
  ml_site_id: site,
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  attrs?: Record<string, string>;
  cookies?: Record<string, string>;
  href?: string;
  queue?: unknown[][];
  links?: { href: string }[];
  storage?: Record<string, string>;
  legacyQueue?: boolean;
  /** Queue the calls on this global instead (founderdata, or minilytics with legacyQueue). */
  queueGlobal?: string;
  /** A browser with PerformanceObserver: these entry types are supported, and `entries` are buffered already. */
  perf?: { types: string[]; entries?: Record<string, unknown[]>; navigation?: Record<string, number> };
  code?: string;
  /** The page loads in a background tab. */
  hidden?: boolean;
}

function load(o: Opts = {}) {
  const attrs: Record<string, string> = { 'data-website-id': 'site123', ...o.attrs };
  const jar = new Map(Object.entries(o.cookies ?? {}));
  const cookieWrites: string[] = [];
  const storageWrites: string[] = [];
  const requests: any[] = [];
  const beacons: any[] = [];
  const listeners: { type: string; fn: (e: unknown) => void }[] = [];
  const document = {
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(str: string) {
      cookieWrites.push(str);
      const [nv, ...rest] = str.split(';');
      const i = nv.indexOf('=');
      const name = nv.slice(0, i).trim();
      const maxAge = rest.map((a) => a.trim()).find((a) => a.startsWith('max-age='));
      if (maxAge && Number(maxAge.slice(8)) <= 0) jar.delete(name);
      else jar.set(name, nv.slice(i + 1));
    },
    currentScript: {
      src: 'https://stats.example/js/script.js',
      getAttribute: (n: string) => attrs[n] ?? null,
      hasAttribute: (n: string) => n in attrs,
    },
    referrer: 'https://www.google.com/',
    visibilityState: o.hidden ? 'hidden' : 'visible',
    readyState: 'complete',
    documentElement: {},
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.push({ type, fn }),
    querySelectorAll: () => o.links ?? [],
  };
  const store = new Map(Object.entries(o.storage ?? {}));
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => (storageWrites.push(k), store.set(k, v)),
    removeItem: (k: string) => (storageWrites.push(k), store.delete(k)),
  };
  const window: any = {
    location: new URL(o.href ?? 'https://example.com/pricing'),
    navigator: {
      webdriver: false,
      sendBeacon: (_u: string, blob: Blob) => {
        beacons.push(blob.text().then(JSON.parse));
        return true;
      },
    },
    screen: { width: 1440 },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    crypto: globalThis.crypto,
  };
  if (o.queue)
    window[o.queueGlobal ?? (o.legacyQueue ? 'minilytics' : 'founderdata')] = Object.assign(() => {}, { q: o.queue });
  // A fake PerformanceObserver: observe() delivers the buffered entries, emit() delivers new ones.
  const observers: { type: string; cb: (l: { getEntries: () => unknown[] }) => void }[] = [];
  if (o.perf) {
    const perf = o.perf;
    window.PerformanceObserver = class {
      static supportedEntryTypes = perf.types;
      constructor(private cb: (l: { getEntries: () => unknown[] }) => void) {}
      observe(opts: { type: string; buffered?: boolean }) {
        observers.push({ type: opts.type, cb: this.cb });
        const buffered = perf.entries?.[opts.type] ?? [];
        if (opts.buffered && buffered.length) this.cb({ getEntries: () => buffered });
      }
    };
    window.performance = { getEntriesByType: (t: string) => (t === 'navigation' ? [perf.navigation ?? {}] : []), now: () => 60_000 };
  }
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    return body.vid ? new Response(null, { status: 202 }) : Response.json(SERVER_IDS, { status: 202 });
  };
  const ctx = vm.createContext({
    window,
    document,
    localStorage,
    fetch,
    screen: window.screen,
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    Blob,
    Response,
    setTimeout,
    setInterval: () => 0,
  });
  vm.runInContext(o.code ?? CODE, ctx);
  const ml = window.founderdata as ((...a: unknown[]) => void) & { attribution: () => Record<string, string> };
  /** Clicks an element that carries the given attributes (not a link). */
  const click = (attributes: Record<string, string>) => {
    const el = {
      attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
      getAttribute: (n: string) => attributes[n] ?? null,
      closest: (sel: string) => (sel.includes('goal') && Object.keys(attributes).some((k) => /^data-(rt|ml)-goal$/.test(k)) ? el : null),
    };
    for (const l of listeners) if (l.type === 'click') l.fn({ target: el });
  };
  const emit = (type: string, ...entries: unknown[]) => {
    for (const ob of observers) if (ob.type === type) ob.cb({ getEntries: () => entries });
  };
  /** The tab goes to the background, as on a tab switch or before the page unloads. */
  const hide = () => {
    document.visibilityState = 'hidden';
    for (const l of listeners) if (l.type === 'visibilitychange') l.fn({});
  };
  const show = () => {
    document.visibilityState = 'visible';
    for (const l of listeners) if (l.type === 'visibilitychange') l.fn({});
  };
  return { ml, window, store, jar, cookieWrites, storageWrites, requests, beacons, click, emit, hide, show };
}

describe('tracker: cookieless by default', () => {
  it('sets no cookies and no storage, and lets the server derive the ids', async () => {
    const t = load();
    expect(t.requests[0]).toMatchObject({ w: 'site123', t: 'pageview', u: 'https://example.com/pricing' });
    expect(t.requests[0].vid).toBeUndefined();
    expect(t.ml.attribution()).toEqual({});
    await tick();
    expect(t.ml.attribution()).toEqual(att(SERVER_IDS.vid, SERVER_IDS.sid));
    // Later events reuse the ids from memory, so beacons work again.
    t.ml('goal', 'signup_click');
    expect(await t.beacons[0]).toMatchObject({ t: 'goal', vid: SERVER_IDS.vid, sid: SERVER_IDS.sid });
    expect(t.cookieWrites).toEqual([]);
    expect(t.storageWrites).toEqual([]);
  });

  it('removes ids left in cookies by an older version', () => {
    const t = load({ cookies: { rt_vid: 'old-visitor-id', rt_sid: 'old-session-id', ml_vid: 'older-visitor', other: 'keep' } });
    expect([...t.jar.keys()]).toEqual(['other']);
    expect(t.requests[0].vid).toBeUndefined();
  });

  it('tags checkout links once the ids are known, leaving the site\'s own client_reference_id alone', async () => {
    const links = [
      { href: 'https://checkout.dodopayments.com/buy/pdt_1?quantity=1' },
      { href: 'https://buy.stripe.com/test_abc' },
      { href: 'https://buy.stripe.com/test_def?client_reference_id=user_42' },
      { href: 'https://buy.stripe.com/test_ghi?client_reference_id=mlv_stale-visitor' },
    ];
    load({ links });
    await tick(80);
    expect(links[0].href).toContain(`metadata_rt_visitor_id=${SERVER_IDS.vid}`);
    expect(links[0].href).toContain(`metadata_rt_session_id=${SERVER_IDS.sid}`);
    expect(links[1].href).toBe(`https://buy.stripe.com/test_abc?client_reference_id=rtv_${SERVER_IDS.vid}`);
    expect(links[2].href).toBe('https://buy.stripe.com/test_def?client_reference_id=user_42');
    expect(links[3].href).toBe(`https://buy.stripe.com/test_ghi?client_reference_id=rtv_${SERVER_IDS.vid}`);
  });
});

describe('tracker: cookies with consent', () => {
  it('data-cookies="on" keeps the visitor in first-party cookies', () => {
    const t = load({ attrs: { 'data-cookies': 'on' } });
    const vid = t.jar.get('rt_vid')!;
    expect(vid).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.requests[0]).toMatchObject({ vid, sid: t.jar.get('rt_sid') });
    expect(t.ml.attribution()).toEqual(att(vid, t.jar.get('rt_sid')!));
    expect(t.cookieWrites.some((c) => c.startsWith('rt_vid=') && c.includes('domain=example.com') && c.includes('Secure'))).toBe(true);
  });

  it("consent(true) keeps the current ids so the visit continues; consent(false) deletes them", async () => {
    const t = load();
    await tick();
    t.ml('consent', true);
    expect(t.jar.get('rt_vid')).toBe(SERVER_IDS.vid);
    expect(t.jar.get('rt_sid')).toBe(SERVER_IDS.sid);
    expect(t.jar.get('rt_consent')).toBe('1');
    t.ml('goal', 'after_consent');
    expect(await t.beacons[0]).toMatchObject({ vid: SERVER_IDS.vid, sid: SERVER_IDS.sid });

    t.ml('consent', false);
    expect(t.jar.size).toBe(0);
    expect(t.ml.attribution()).toEqual({});
  });

  it('consent given before the first response arrives still keeps the server ids', async () => {
    const t = load();
    t.ml('consent', true);
    expect(t.jar.has('rt_vid')).toBe(false);
    await tick();
    expect(t.jar.get('rt_vid')).toBe(SERVER_IDS.vid);
  });

  it('remembers consent on the next page load', () => {
    const t = load({ cookies: { rt_consent: '1', rt_vid: 'returning-visitor-1', rt_sid: 'session-0000001' } });
    expect(t.requests[0]).toMatchObject({ vid: 'returning-visitor-1', sid: 'session-0000001' });
  });

  it('applies a queued consent call before the first pageview', () => {
    const t = load({ queue: [['consent', true], ['goal', 'queued_goal']] });
    expect(t.requests[0].t).toBe('pageview');
    expect(t.requests[0].vid).toBe(t.jar.get('rt_vid'));
  });
});

describe('tracker: revtrail name', () => {
  // Sites installed before the rename to FounderData call window.revtrail for goals and for the
  // checkout attribution ids. Dropping the alias silently turned both off on those sites.
  it('window.revtrail is the same function as window.founderdata', () => {
    const t = load();
    expect(t.window.revtrail).toBe(t.window.founderdata);
    expect(t.window.revtrail.attribution).toBe(t.ml.attribution);
  });

  it('runs calls queued on window.revtrail', () => {
    const t = load({ queueGlobal: 'revtrail', queue: [['consent', true]] });
    expect(t.jar.get('rt_consent')).toBe('1');
  });
});

describe('tracker: minilytics names', () => {
  it('window.minilytics is the same function as window.founderdata', () => {
    const t = load();
    expect(t.window.minilytics).toBe(t.window.founderdata);
    expect(t.window.minilytics.attribution).toBe(t.ml.attribution);
  });

  it('runs calls queued on window.minilytics', () => {
    const t = load({ legacyQueue: true, queue: [['consent', true]] });
    expect(t.jar.get('rt_consent')).toBe('1');
    expect(t.requests[0].vid).toBe(t.jar.get('rt_vid'));
  });

  it('migrates consented ml_* cookies to rt_* once, keeping the visitor and session', () => {
    const t = load({ cookies: { ml_consent: '1', ml_vid: 'returning-visitor-1', ml_sid: 'session-0000001' } });
    expect(t.requests[0]).toMatchObject({ vid: 'returning-visitor-1', sid: 'session-0000001' });
    expect(t.jar.get('rt_vid')).toBe('returning-visitor-1');
    expect(t.jar.get('rt_consent')).toBe('1');
    expect([...t.jar.keys()].some((k) => k.startsWith('ml_'))).toBe(false);
  });

  it('keeps the visitor from an ml_vid cookie when the site sets data-cookies="on"', () => {
    const t = load({ attrs: { 'data-cookies': 'on' }, cookies: { ml_vid: 'returning-visitor-2' } });
    expect(t.requests[0].vid).toBe('returning-visitor-2');
    expect(t.jar.has('ml_vid')).toBe(false);
  });

  it('sends goals from data-rt-goal and the older data-ml-goal, with their properties', async () => {
    const t = load();
    await tick();
    t.click({ 'data-rt-goal': 'signup_click', 'data-rt-goal-plan': 'pro' });
    t.click({ 'data-ml-goal': 'pricing_click', 'data-ml-goal-plan': 'team' });
    expect(await t.beacons[0]).toMatchObject({ t: 'goal', n: 'signup_click', p: { plan: 'pro' } });
    expect(await t.beacons[1]).toMatchObject({ t: 'goal', n: 'pricing_click', p: { plan: 'team' } });
  });

  it('honours ?rt_ignore=true and the older ?ml_ignore=true', () => {
    for (const param of ['rt_ignore', 'ml_ignore']) {
      const t = load({ href: `https://example.com/?${param}=true` });
      expect(t.requests).toEqual([]);
      expect(t.store.get('rt_ignore')).toBe('1');
    }
    const t = load({ storage: { ml_ignore: '1' } });
    expect(t.requests).toEqual([]);
    expect(t.store.has('ml_ignore')).toBe(false);
  });
});

describe('tracker: Core Web Vitals', () => {
  const ALL = ['navigation', 'paint', 'largest-contentful-paint', 'layout-shift', 'event', 'first-input'];

  it('sends them once, on the ping when the page is first hidden, without a request of their own', async () => {
    const t = load({
      perf: {
        types: ALL,
        navigation: { responseStart: 182.4, activationStart: 0 },
        entries: {
          paint: [{ name: 'first-paint', startTime: 300 }, { name: 'first-contentful-paint', startTime: 412.6 }],
          'largest-contentful-paint': [{ startTime: 900 }, { startTime: 1650.2 }],
          'layout-shift': [{ startTime: 1000, value: 0.04, hadRecentInput: false }, { startTime: 1500, value: 0.03, hadRecentInput: false }],
        },
      },
    });
    await tick();
    // A later burst more than 1 s after the first is a new window; a shift right after input never counts.
    t.emit('layout-shift', { startTime: 4000, value: 0.05, hadRecentInput: false }, { startTime: 4100, value: 0.5, hadRecentInput: true });
    // Two events of one interaction count once, at the longest; the slowest interaction is the INP below 50.
    t.emit('event', { interactionId: 7, duration: 120 }, { interactionId: 7, duration: 180 }, { interactionId: 0, duration: 900 });
    t.emit('first-input', { interactionId: 9, duration: 64 });
    const before = t.requests.length;
    t.hide();
    expect(t.requests.length).toBe(before);
    const sent = await Promise.all(t.beacons);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'ping', vid: SERVER_IDS.vid, v: { t: 182, f: 413, l: 1650, c: 0.07, i: 180, p: '/pricing' } });
    // Back and hidden again: engaged time only.
    t.show();
    t.hide();
    expect((await Promise.all(t.beacons)).slice(1).every((b) => b.v === undefined)).toBe(true);
  });

  it('a page loaded in a background tab sends no paint times', async () => {
    const t = load({
      hidden: true,
      perf: { types: ALL, navigation: { responseStart: 90 }, entries: { paint: [{ name: 'first-contentful-paint', startTime: 50 }], 'largest-contentful-paint': [{ startTime: 70 }] } },
    });
    await tick();
    t.show();
    t.hide();
    const [ping] = await Promise.all(t.beacons);
    expect(ping.v).toEqual({ t: 90, c: 0, p: '/pricing' });
  });

  it('sends nothing extra in a browser without PerformanceObserver', async () => {
    const t = load();
    await tick();
    t.hide();
    expect(t.beacons).toHaveLength(0);
    expect(t.requests).toHaveLength(1);
  });

  it('the minified build tracks the same pageview and vitals', async () => {
    expect(MINIFIED.length).toBeLessThan(CODE.length * 0.7);
    expect(MINIFIED.startsWith('/*! FounderData tracker')).toBe(true);
    const t = load({ code: MINIFIED, perf: { types: ALL, navigation: { responseStart: 100 } } });
    expect(t.requests[0]).toMatchObject({ w: 'site123', t: 'pageview', u: 'https://example.com/pricing' });
    await tick();
    t.hide();
    expect((await Promise.all(t.beacons))[0]).toMatchObject({ t: 'ping', v: { t: 100, c: 0, p: '/pricing' } });
  });
});
