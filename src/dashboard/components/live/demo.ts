/**
 * The built-in demo for the live view (`?demo=1`): three made-up products and a crowd that arrives, browses, leaves
 * and sometimes pays. It answers in the GET /api/live wire format and goes through the same adapter as the server,
 * so the demo also exercises the parsing. Loaded on demand; a normal session never downloads it.
 */

const CITIES: [city: string, region: string, cc: string, lat: number, lon: number, weight: number][] = [
  ['Berlin', 'Berlin', 'DE', 52.5, 13.4, 9],
  ['Munich', 'Bavaria', 'DE', 48.1, 11.6, 4],
  ['Hamburg', 'Hamburg', 'DE', 53.6, 10, 3],
  ['Vienna', 'Vienna', 'AT', 48.2, 16.4, 3],
  ['Zurich', 'Zurich', 'CH', 47.4, 8.5, 3],
  ['London', 'England', 'GB', 51.5, -0.1, 8],
  ['Manchester', 'England', 'GB', 53.5, -2.2, 2],
  ['Dublin', 'Leinster', 'IE', 53.3, -6.3, 2],
  ['Paris', 'Ile-de-France', 'FR', 48.9, 2.4, 5],
  ['Amsterdam', 'North Holland', 'NL', 52.4, 4.9, 4],
  ['Copenhagen', 'Capital Region', 'DK', 55.7, 12.6, 2],
  ['Stockholm', 'Stockholm', 'SE', 59.3, 18.1, 2],
  ['Madrid', 'Madrid', 'ES', 40.4, -3.7, 2],
  ['Lisbon', 'Lisbon', 'PT', 38.7, -9.1, 2],
  ['Warsaw', 'Masovia', 'PL', 52.2, 21, 2],
  ['New York', 'New York', 'US', 40.7, -74, 9],
  ['San Francisco', 'California', 'US', 37.8, -122.4, 7],
  ['Los Angeles', 'California', 'US', 34.1, -118.2, 4],
  ['Austin', 'Texas', 'US', 30.3, -97.7, 3],
  ['Chicago', 'Illinois', 'US', 41.9, -87.6, 3],
  ['Seattle', 'Washington', 'US', 47.6, -122.3, 3],
  ['Toronto', 'Ontario', 'CA', 43.7, -79.4, 3],
  ['Vancouver', 'British Columbia', 'CA', 49.3, -123.1, 2],
  ['Mexico City', 'Mexico City', 'MX', 19.4, -99.1, 2],
  ['Sao Paulo', 'Sao Paulo', 'BR', -23.6, -46.6, 3],
  ['Buenos Aires', 'Buenos Aires', 'AR', -34.6, -58.4, 1],
  ['Bangalore', 'Karnataka', 'IN', 13, 77.6, 4],
  ['Mumbai', 'Maharashtra', 'IN', 19.1, 72.9, 2],
  ['Singapore', 'Singapore', 'SG', 1.3, 103.8, 3],
  ['Tokyo', 'Tokyo', 'JP', 35.7, 139.7, 4],
  ['Seoul', 'Seoul', 'KR', 37.6, 127, 2],
  ['Sydney', 'New South Wales', 'AU', -33.9, 151.2, 3],
  ['Melbourne', 'Victoria', 'AU', -37.8, 145, 2],
  ['Auckland', 'Auckland', 'NZ', -36.8, 174.8, 1],
  ['Cape Town', 'Western Cape', 'ZA', -33.9, 18.4, 1],
  ['Lagos', 'Lagos', 'NG', 6.5, 3.4, 1],
  ['Dubai', 'Dubai', 'AE', 25.2, 55.3, 2],
  ['Tel Aviv', 'Tel Aviv', 'IL', 32.1, 34.8, 1],
  ['Istanbul', 'Istanbul', 'TR', 41, 29, 1],
];

const SITES = [
  {
    id: 'demo-notes',
    name: 'Acme Notes',
    domain: 'acme.example',
    platform: 'web' as const,
    weight: 5,
    pages: ['/', '/pricing', '/features', '/blog/second-brain-in-a-weekend', '/blog/markdown-vs-rich-text', '/docs/import', '/changelog', '/signup'],
    plans: [900, 900, 1900, 9000],
    currency: 'USD',
  },
  {
    id: 'demo-app',
    name: 'Lumen for iPhone',
    domain: 'lumen.example',
    platform: 'app' as const,
    weight: 3,
    pages: ['Today', 'Journal', 'Paywall', 'Settings', 'Onboarding', 'Stats'],
    plans: [499, 499, 2999],
    currency: 'EUR',
  },
  {
    id: 'demo-guide',
    name: 'Field Guide',
    domain: 'fieldguide.example',
    platform: 'web' as const,
    weight: 2,
    pages: ['/', '/routes/lisbon-in-three-days', '/routes/kyoto-by-bike', '/pricing', '/about'],
    plans: [1500, 3900],
    currency: 'EUR',
  },
];

const SOURCES = ['Google', 'Google', 'Google', 'Direct', 'Direct', 'X', 'Hacker News', 'Reddit', 'ChatGPT', 'Newsletter', 'Product Hunt', 'Bing'];
const APP_SOURCES = ['App Store', 'App Store', 'Apple Search Ads', 'Direct'];
const DEVICES = ['desktop', 'desktop', 'mobile', 'mobile', 'mobile', 'tablet'] as const;

/** A seeded generator, so the demo opens on the same crowd each time. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Visitor = {
  id: string;
  siteId: string;
  platform: 'web' | 'app';
  country: string;
  region: string;
  city: string;
  lat: number | null;
  lon: number | null;
  page: string;
  source: string;
  device: string;
  customer: boolean;
  startedAt: number;
  lastSeenAt: number;
  leaveAt: number;
};

type Event = { id: string; ts: number; siteId: string; kind: string; label: string; amount: number | null; currency: string | null; country: string; city: string; lat: number; lon: number };

export function createDemo(seed = 7, start = Date.now()) {
  const rand = rng(seed);
  const pickW = <T extends { weight?: number }>(xs: T[], w: (x: T) => number) => {
    const total = xs.reduce((s, x) => s + w(x), 0);
    let r = rand() * total;
    for (const x of xs) if ((r -= w(x)) <= 0) return x;
    return xs[xs.length - 1];
  };
  const one = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const cities = CITIES.map((c) => ({ c, weight: c[5] }));

  let n = 0;
  let visitors: Visitor[] = [];
  const events: Event[] = [];
  let clock = start;
  let nextPayment = start + 5_000;
  let nextOther = start + 14_000;

  function arrive(at: number, age = 0) {
    const site = pickW(SITES, (s) => s.weight);
    const [city, region, cc, lat, lon] = pickW(cities, (c) => c.weight).c;
    // About one visitor in eight has no city on record, like an old row; the globe then uses the country.
    const noCity = rand() < 0.12;
    const started = at - age;
    visitors.push({
      id: `v${seed}-${++n}`,
      siteId: site.id,
      platform: site.platform,
      country: cc,
      region: noCity ? '' : region,
      city: noCity ? '' : city,
      lat: noCity ? null : Math.round((lat + (rand() - 0.5) * 0.6) * 10) / 10,
      lon: noCity ? null : Math.round((lon + (rand() - 0.5) * 0.6) * 10) / 10,
      page: one(site.pages),
      source: site.platform === 'app' ? one(APP_SOURCES) : one(SOURCES),
      device: site.platform === 'app' ? 'mobile' : one(DEVICES),
      customer: rand() < 0.14,
      startedAt: started,
      lastSeenAt: at,
      // Someone already there when the demo opens still stays a while.
      leaveAt: Math.max(started + 25_000 + rand() * 200_000, at + 15_000 + rand() * 120_000),
    });
  }

  function emit(kind: string, at: number) {
    const v = visitors.length ? one(visitors) : null;
    const site = SITES.find((s) => s.id === v?.siteId) ?? SITES[0];
    const [city, , cc, lat, lon] = v?.city ? CITIES.find((c) => c[0] === v.city)! : pickW(cities, (c) => c.weight).c;
    const amount = kind === 'payment' ? one(site.plans) : null;
    const label = kind === 'payment' ? (amount! >= 2900 ? 'Yearly plan' : 'Monthly plan') : kind === 'trial' ? 'Started a trial' : kind === 'signup' ? 'Created an account' : 'Joined the waitlist';
    events.unshift({ id: `e${seed}-${++n}`, ts: at, siteId: site.id, kind, label, amount, currency: amount ? site.currency : null, country: cc, city, lat, lon });
    if (v && kind === 'payment') v.customer = true;
  }

  // Open on a crowd that is already there, and a few payments from the last hour.
  for (let i = 0; i < 17; i++) arrive(start, rand() * 150_000);
  for (let i = 0; i < 4; i++) emit(i % 2 ? 'payment' : i === 2 ? 'trial' : 'payment', start - 300_000 - i * 700_000);
  events.sort((a, b) => b.ts - a.ts);

  const places = (() => {
    const totals = new Map<string, number>();
    for (let i = 0; i < 900; i++) {
      const c = pickW(cities, (x) => x.weight).c;
      totals.set(c[0], (totals.get(c[0]) ?? 0) + 1);
    }
    return CITIES.map(([city, , country, lat, lon]) => ({ city, country, lat, lon, visitors: totals.get(city) ?? 1 }))
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, 60);
  })();

  /** Moves the crowd forward to `now` and answers like GET /api/live. */
  return function snapshot(now = Date.now()) {
    const dt = Math.max(0, now - clock);
    clock = now;
    // Arrivals hover around 18 people online: more likely when the room is quiet.
    const expected = (dt / 1000) * (visitors.length < 14 ? 0.32 : visitors.length > 24 ? 0.06 : 0.16);
    let k = Math.floor(expected) + (rand() < expected % 1 ? 1 : 0);
    while (k-- > 0) arrive(now);
    visitors = visitors.filter((v) => v.leaveAt > now);
    for (const v of visitors) {
      if (rand() < dt / 40_000) {
        const site = SITES.find((s) => s.id === v.siteId)!;
        v.page = one(site.pages);
      }
      v.lastSeenAt = Math.min(now, v.lastSeenAt + dt);
    }
    if (now >= nextPayment) {
      emit('payment', now);
      nextPayment = now + 22_000 + rand() * 26_000;
    }
    if (now >= nextOther) {
      emit(one(['trial', 'signup', 'signup', 'goal']), now);
      nextOther = now + 15_000 + rand() * 20_000;
    }
    while (events.length && events[events.length - 1].ts < now - 3_600_000) events.pop();

    const online = new Map<string, number>();
    for (const v of visitors) online.set(v.siteId, (online.get(v.siteId) ?? 0) + 1);
    return {
      now,
      windowMinutes: 5,
      online: visitors.length,
      sites: SITES.map((s) => ({ id: s.id, name: s.name, domain: s.domain, online: online.get(s.id) ?? 0 })),
      visitors: visitors.slice(-150).map(({ leaveAt: _, ...v }) => ({ ...v, region: v.region || null, city: v.city || null })),
      events: events.slice(0, 30),
      places,
    };
  };
}
