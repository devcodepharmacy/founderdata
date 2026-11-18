import { describe, expect, it } from 'vitest';
import { feedVisitors, windowActivity, parseLive } from '../src/dashboard/components/live/adapter';
import { createDemo } from '../src/dashboard/components/live/demo';
import { countryPoint, isLand, landDots, placePoint, toVector } from '../src/dashboard/lib/geo';
import { rotate } from '../src/dashboard/components/live/globe-gl';

describe('geo', () => {
  it('has a point for every ISO 3166-1 alpha-2 code', () => {
    const codes =
      'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(' ');
    const missing = codes.filter((c) => !countryPoint(c));
    expect(missing).toEqual([]);
    expect(countryPoint('de')).toEqual(countryPoint('DE'));
    expect(countryPoint('XX')).toBeNull();
    expect(countryPoint(null)).toBeNull();
  });

  it('puts label points inside their country, roughly', () => {
    const [lat, lon] = countryPoint('DE')!;
    expect(lat).toBeGreaterThan(47);
    expect(lat).toBeLessThan(55);
    expect(lon).toBeGreaterThan(6);
    expect(lon).toBeLessThan(15);
  });

  it('reads land and water from the mask', () => {
    expect(isLand(52.5, 13.4)).toBe(true); // Berlin
    expect(isLand(40.7, -100)).toBe(true); // Nebraska
    expect(isLand(-25, 134)).toBe(true); // central Australia
    expect(isLand(30, -40)).toBe(false); // Atlantic
    expect(isLand(0, -150)).toBe(false); // Pacific
    expect(isLand(-30, 80)).toBe(false); // Indian Ocean
  });

  it('lays out land dots, more of them on a finer step', () => {
    const coarse = landDots(2).length / 2;
    const fine = landDots(1).length / 2;
    expect(coarse).toBeGreaterThan(1500);
    expect(fine).toBeGreaterThan(coarse * 3);
  });

  it('places a visitor at its own coordinates, rounded to one decimal', () => {
    expect(placePoint({ id: 'a', lat: 52.5234, lon: 13.4114, country: 'DE' })).toEqual([52.5, 13.4]);
  });

  it('spreads visitors without a city around their country, the same way every time', () => {
    const a = placePoint({ id: 'visitor-1', lat: null, lon: null, country: 'FR' })!;
    const b = placePoint({ id: 'visitor-2', lat: null, lon: null, country: 'FR' })!;
    expect(placePoint({ id: 'visitor-1', lat: null, lon: null, country: 'FR' })).toEqual(a);
    expect(a).not.toEqual(b);
    const [clat, clon] = countryPoint('FR')!;
    for (const p of [a, b]) {
      expect(Math.abs(p[0] - clat)).toBeLessThanOrEqual(1.2);
      expect(Math.abs(p[1] - clon)).toBeLessThanOrEqual(2);
    }
  });

  it('leaves an unknown country off the map', () => {
    expect(placePoint({ id: 'x', lat: null, lon: null, country: null })).toBeNull();
  });

  it('turns a point to face the viewer', () => {
    const v = toVector(0, 90);
    const p = rotate(v, -Math.PI / 2, 0);
    expect(p[0]).toBeCloseTo(0);
    expect(p[2]).toBeCloseTo(1);
    // A positive tilt brings the north pole toward the viewer.
    expect(rotate(toVector(90, 0), 0, 0.5)[2]).toBeGreaterThan(0);
  });
});

describe('live adapter', () => {
  it('reads the documented payload', () => {
    const d = parseLive({
      now: 1_700_000_000_000,
      windowMinutes: 5,
      online: 2,
      sites: [
        { id: 's1', name: 'Acme', domain: 'acme.example', online: 1 },
        { id: 's2', name: 'Beta', domain: 'beta.example', online: 2 },
      ],
      visitors: [
        { id: 'v1', siteId: 's1', platform: 'web', country: 'de', region: 'Berlin', city: 'Berlin', lat: 52.5234, lon: 13.4114, page: '/pricing', source: 'Google', device: 'desktop', customer: true, startedAt: 1_699_999_900_000, lastSeenAt: 1_699_999_990_000 },
        { id: 'v2', siteId: 's2', platform: 'app', country: null, region: null, city: null, lat: null, lon: null, page: null, source: null, device: 'watch', customer: false, startedAt: 1_699_999_950_000, lastSeenAt: 1_699_999_995_000 },
      ],
      events: [{ ts: 1_699_999_000_000, siteId: 's1', kind: 'payment', label: 'Pro', amount: 1900, currency: 'usd', country: 'US', city: 'Austin', lat: 30.27, lon: -97.74 }],
      places: [{ country: 'DE', city: 'Berlin', lat: 52.5, lon: 13.4, visitors: 40 }],
    });
    expect(d.online).toBe(2);
    expect(d.sites.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(d.visitors[0].id).toBe('v2'); // newest first
    const v1 = d.visitors.find((v) => v.id === 'v1')!;
    expect(v1).toMatchObject({ country: 'DE', lat: 52.5, lon: 13.4, customer: true, device: 'desktop' });
    const v2 = d.visitors.find((v) => v.id === 'v2')!;
    expect(v2).toMatchObject({ platform: 'app', device: null, lat: null, country: null });
    expect(d.events[0]).toMatchObject({ kind: 'payment', amount: 1900, currency: 'USD', lat: 30.3, lon: -97.7 });
    expect(d.events[0].key).toBeTruthy();
    expect(d.places).toHaveLength(1);
  });

  it('survives junk without throwing', () => {
    const d = parseLive({ visitors: [null, 3, { id: 'ok', lat: 999, lon: 'x' }], events: [{ kind: 'refund', ts: 1 }], sites: 'no' }, 5);
    expect(d.visitors).toHaveLength(1);
    expect(d.visitors[0]).toMatchObject({ lat: null, lon: null });
    expect(d.events).toEqual([]);
    expect(d.online).toBe(1);
    expect(d.now).toBe(5);
    expect(parseLive(null).visitors).toEqual([]);
  });

  it('takes seconds as well as milliseconds', () => {
    const d = parseLive({ now: 1_700_000_000, visitors: [{ id: 'a', startedAt: 1_700_000_000, lastSeenAt: '2023-11-14T22:13:20Z' }] });
    expect(d.now).toBe(1_700_000_000_000);
    expect(d.visitors[0].startedAt).toBe(1_700_000_000_000);
    expect(d.visitors[0].lastSeenAt).toBe(1_700_000_000_000);
  });

  it('reads a window\'s count, sites, money and events, and keeps the money current between refreshes', () => {
    const now = 1_700_000_000_000;
    const ev = (id: string, minutesAgo: number, amount: number | null) => ({ id, ts: now - minutesAgo * 60_000, siteId: 's1', kind: amount ? 'payment' : 'signup', amount, currency: amount ? 'usd' : null });
    const d = parseLive({
      now,
      visitors: [],
      events: [ev('new', 1, 900), ev('known', 30, 1900)],
      recent: [{ id: 'a', siteId: 's1', lastSeenAt: now - 60_000 }],
      recentCount: 412,
      recentSites: [{ id: 's2', name: 'B', domain: 'b.example', visitors: 12 }, { id: 's1', name: 'A', domain: 'a.example', visitors: 400 }, { id: 's3', visitors: 0 }],
      recentRevenue: [{ currency: 'usd', amount: 6800, payments: 2 }],
      recentEvents: [ev('known', 30, 1900), ev('old', 600, 4900), ev('joined', 700, null)],
    });
    expect([d.recentCount, d.recentAt]).toEqual([412, now]);
    expect(d.recentSites.map((s) => [s.id, s.visitors])).toEqual([['s1', 400], ['s2', 12]]);
    expect(d.recentRevenue).toEqual([{ currency: 'USD', amount: 6800, payments: 2 }]);
    // A day: both lists, each event once. Nothing is newer than the window's read, so the money is the server's.
    const day = windowActivity(d, 1440);
    expect(day.events.map((e) => e.key)).toEqual(['new', 'known', 'old', 'joined']);
    expect(day.revenue).toEqual([{ currency: 'USD', amount: 6800, payments: 2 }]);
    // A later poll brings a payment the window's read did not have: it is added once.
    const later = { ...d, now: now + 60_000, events: [{ ...d.events[0], key: 'fresh', ts: now + 30_000 }, ...d.events] };
    expect(windowActivity(later, 1440).revenue).toEqual([{ currency: 'USD', amount: 7700, payments: 3 }]);
    expect(windowActivity(later, 1440).events[0].key).toBe('fresh');
    // An older server sends the list only: its length is the count.
    const old = parseLive({ now, recent: [{ id: 'a' }, { id: 'b' }] });
    expect([old.recentCount, old.recentSites, old.recentRevenue, old.recentEvents]).toEqual([2, [], [], []]);
    expect(parseLive({ now }).recentAt).toBeNull();
  });

  it('reads the recent visitors, newest activity first, and an empty list without them', () => {
    const d = parseLive({
      now: 1_700_000_000_000,
      visitors: [{ id: 'on', siteId: 's1', startedAt: 1_699_999_900_000, lastSeenAt: 1_699_999_990_000, page: '/now' }],
      recent: [
        { id: 'old', siteId: 's1', country: 'fr', startedAt: 1_699_900_000_000, lastSeenAt: 1_699_900_100_000 },
        { id: 'on', siteId: 's1', startedAt: 1_699_999_900_000, lastSeenAt: 1_699_999_700_000, page: '/then' },
        { id: 'mid', siteId: 's2', startedAt: 1_699_990_000_000, lastSeenAt: 1_699_990_100_000 },
      ],
    });
    expect(d.recent.map((v) => v.id)).toEqual(['on', 'mid', 'old']);
    expect(d.recent[2].country).toBe('FR');
    expect(parseLive({ visitors: [] }).recent).toEqual([]);
    // The list: the window's visitors, the online row winning, newest activity first. Without a window, only online.
    expect(feedVisitors(d, true).map((v) => [v.id, v.page])).toEqual([['on', '/now'], ['mid', null], ['old', null]]);
    expect(feedVisitors(d, false).map((v) => v.id)).toEqual(['on']);
    expect(feedVisitors(null, true)).toEqual([]);
  });

  it('keeps one row per visitor', () => {
    const d = parseLive({ visitors: [{ id: 'a', lastSeenAt: 10_000_000_000_000 }, { id: 'a', lastSeenAt: 10_000_000_100_000, page: '/new' }] });
    expect(d.visitors).toHaveLength(1);
    expect(d.visitors[0].page).toBe('/new');
  });
});

describe('live demo', () => {
  it('answers in the wire format and moves over time', () => {
    const start = 1_800_000_000_000;
    const snap = createDemo(7, start);
    const first = parseLive(snap(start));
    expect(first.online).toBeGreaterThan(10);
    expect(first.visitors.length).toBe(first.online);
    expect(first.sites.reduce((n, s) => n + s.online, 0)).toBe(first.online);
    expect(first.places.length).toBeGreaterThan(10);
    // A day of visitors who came and went, newest first, none of them online.
    expect(first.recent.length).toBeGreaterThan(100);
    expect(first.recent[0].lastSeenAt).toBeGreaterThanOrEqual(first.recent[first.recent.length - 1].lastSeenAt);
    expect(first.recent.every((v) => v.lastSeenAt > start - 24 * 3_600_000)).toBe(true);
    // Coordinates in the demo are one decimal at most, like the server's.
    for (const v of first.visitors) if (v.lat != null) expect(Math.round(v.lat * 10) / 10).toBe(v.lat);
    let later = first;
    for (let t = 1; t <= 40; t++) later = parseLive(snap(start + t * 2500));
    expect(later.events.some((e) => e.kind === 'payment' && e.ts >= start)).toBe(true);
    const ids = new Set(first.visitors.map((v) => v.id));
    expect(later.visitors.some((v) => !ids.has(v.id))).toBe(true);
  });
});

describe('live polling url', () => {
  it('leaves places out unless they are due', async () => {
    const { liveUrl } = await import('../src/dashboard/components/live/useLive');
    expect(liveUrl('/api/live', true)).toBe('/api/live');
    expect(liveUrl('/api/live', false)).toBe('/api/live?places=0');
    expect(liveUrl('/api/live?x=1', false)).toBe('/api/live?x=1&places=0');
    expect(liveUrl('/api/live', true, 60)).toBe('/api/live?placesMinutes=60');
    expect(liveUrl('/api/live', false, 60)).toBe('/api/live?places=0');
  });

  it('keeps only the events of the window on the globe', async () => {
    const { recentEvents } = await import('../src/dashboard/components/live/shared');
    const now = 10_000_000;
    const at = (minAgo: number) => ({ key: `k${minAgo}`, ts: now - minAgo * 60_000 }) as any;
    expect(recentEvents([at(1), at(4), at(6), at(50)], now, 5).map((e) => e.key)).toEqual(['k1', 'k4']);
    expect(recentEvents([at(1), at(50), at(70)], now, 60).map((e) => e.key)).toEqual(['k1', 'k50']);
  });

  it('reads places: null as no places', () => {
    expect(parseLive({ places: null }).places).toEqual([]);
  });
});
