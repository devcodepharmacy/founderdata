import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The dashboard's answer cache (src/dashboard/lib/cache.ts). It keeps analytics and revenue in tab memory only, so
// these tests pin its rules: stale-while-revalidate, shared requests, aborts, and the clear on
// logout and on a role change.

type Cache = typeof import('../src/dashboard/lib/cache');
type Api = typeof import('../src/dashboard/lib/api');

let cache: Cache;
let apiMod: Api;
let win: EventTarget & Record<string, any>;
const calls: { url: string; signal?: AbortSignal; resolve: (v: unknown, status?: number) => void }[] = [];

beforeAll(async () => {
  win = new EventTarget() as any;
  vi.stubGlobal('window', win);
  // Each fetch stays open until a test resolves it, so the order of events is the test's to choose.
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      return new Promise((resolve, reject) => {
        const call = {
          url,
          signal: init?.signal as AbortSignal | undefined,
          resolve: (v: unknown, status = 200) => resolve({ ok: status < 400, status, statusText: 'x', headers: new Headers(), json: async () => v }),
        };
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        calls.push(call);
      });
    }),
  );
  cache = await import('../src/dashboard/lib/cache');
  apiMod = await import('../src/dashboard/lib/api');
});

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  cache.clearCache();
  calls.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('dashboard cache', () => {
  it('shares one request between components and answers both', async () => {
    const a = cache.acquire('/api/x', false);
    const b = cache.acquire('/api/x', false);
    expect(calls).toHaveLength(1);
    expect(cache.peek('/api/x').inflight).toBe(true);
    calls[0].resolve({ n: 1 });
    await tick();
    expect(cache.peek('/api/x')).toMatchObject({ has: true, data: { n: 1 }, inflight: false, error: null });
    a();
    b();
  });

  it('serves a fresh answer without asking again, and asks again when the reload key forces it', async () => {
    cache.acquire('/api/x', false)();
    calls[0].resolve({ n: 1 });
    await tick();
    cache.acquire('/api/x', false)();
    expect(calls).toHaveLength(1);
    cache.acquire('/api/x', true)();
    expect(calls).toHaveLength(2);
    // The old answer stays readable while the new one loads.
    expect(cache.peek('/api/x')).toMatchObject({ has: true, data: { n: 1 }, inflight: true });
  });

  it('revalidates an answer older than the freshness window and keeps showing it meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    cache.acquire('/api/x', false)();
    calls[0].resolve({ n: 1 });
    await vi.waitFor(() => expect(cache.peek('/api/x').has).toBe(true));
    vi.advanceTimersByTime(6_000);
    cache.acquire('/api/x', false)();
    expect(calls).toHaveLength(2);
    expect(cache.peek('/api/x')).toMatchObject({ has: true, data: { n: 1 }, inflight: true });
  });

  it('marks everything stale after a write, so the next mount refetches', async () => {
    cache.acquire('/api/x', false)();
    calls[0].resolve({ n: 1 });
    await tick();
    win.dispatchEvent(new Event('fd:wrote'));
    cache.acquire('/api/x', false)();
    expect(calls).toHaveLength(2);
  });

  it('does not trust an answer to a request that began before a write', async () => {
    const release = cache.acquire('/api/x', false);
    win.dispatchEvent(new Event('fd:wrote'));
    // A component that mounts after the write asks again instead of joining the old request.
    cache.acquire('/api/x', false)();
    expect(calls).toHaveLength(2);
    expect(calls[0].signal?.aborted).toBe(true);
    calls[1].resolve({ n: 2 });
    await tick();
    expect(cache.peek('/api/x')).toMatchObject({ has: true, data: { n: 2 } });
    expect(cache.peek('/api/x').ts).toBeGreaterThan(0);
    release();
  });

  it('counts an answer stale when the write landed while the request ran and nobody asked again', async () => {
    cache.prefetch('/api/p');
    win.dispatchEvent(new Event('fd:wrote'));
    calls[0].resolve({ n: 1 });
    await tick();
    expect(cache.peek('/api/p')).toMatchObject({ has: true, data: { n: 1 }, ts: 0 });
    cache.acquire('/api/p', false)();
    expect(calls).toHaveLength(2);
  });

  it('several mounts after one write share one new request', async () => {
    cache.acquire('/api/x', false)();
    calls[0].resolve({ n: 1 });
    await tick();
    win.dispatchEvent(new Event('fd:wrote'));
    const a = cache.acquire('/api/x', false);
    const b = cache.acquire('/api/x', false);
    expect(calls).toHaveLength(2);
    expect(calls[1].signal?.aborted).toBe(false);
    a();
    b();
  });

  it('aborts a request nobody waits for, but never one a prefetch started', async () => {
    const release = cache.acquire('/api/a', false);
    release();
    await tick();
    expect(calls[0].signal?.aborted).toBe(true);
    expect(cache.peek('/api/a').inflight).toBe(false);

    cache.prefetch('/api/b');
    const r2 = cache.acquire('/api/b', false);
    r2();
    await tick();
    expect(calls[1].signal?.aborted).toBe(false);
    calls[1].resolve({ ok: true });
    await tick();
    expect(cache.peek('/api/b').data).toEqual({ ok: true });
  });

  it('does not abort when a component unmounts and remounts in the same tick (StrictMode)', async () => {
    cache.acquire('/api/s', false)();
    cache.acquire('/api/s', false);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].signal?.aborted).toBe(false);
  });

  it('keeps the last good answer and reports an error when a refresh fails', async () => {
    cache.acquire('/api/x', false)();
    calls[0].resolve({ n: 1 });
    await tick();
    cache.acquire('/api/x', true)();
    calls[1].resolve({ error: 'nope' }, 500);
    await tick();
    expect(cache.peek('/api/x')).toMatchObject({ has: true, data: { n: 1 }, error: 'nope', inflight: false });
  });

  it('empties on logout and on a role change, and ignores the answer of a request that was running', async () => {
    cache.acquire('/api/x', false)();
    calls[0].resolve({ n: 1 });
    await tick();
    cache.acquire('/api/y', false);
    win.dispatchEvent(new Event('ml:logout'));
    expect(cache.peek('/api/x').has).toBe(false);
    expect(calls[1].signal?.aborted).toBe(true);
    calls[1].resolve({ late: true });
    await tick();
    expect(cache.peek('/api/y').has).toBe(false);

    cache.acquire('/api/x', false)();
    calls[2].resolve({ n: 2 });
    await tick();
    win.dispatchEvent(new Event('fd:role-changed'));
    expect(cache.peek('/api/x').has).toBe(false);
  });

  it('setRole clears the cache only when the role changes after it was known', async () => {
    cache.acquire('/api/x', false)();
    calls[0].resolve({ n: 1 });
    await tick();
    apiMod.setRole('admin'); // the first call, from /api/auth/me: records the role
    expect(cache.peek('/api/x').has).toBe(true);
    apiMod.setRole('admin');
    expect(cache.peek('/api/x').has).toBe(true);
    apiMod.setRole('viewer');
    expect(cache.peek('/api/x').has).toBe(false);
    apiMod.setRole('admin');
  });

  it('a write through api() marks the cache stale', async () => {
    cache.acquire('/api/x', false)();
    calls[0].resolve({ n: 1 });
    await tick();
    const write = apiMod.api('/api/sites/s1', { method: 'PATCH', json: { name: 'n' } });
    calls[1].resolve({ ok: true });
    await write;
    cache.acquire('/api/x', false)();
    expect(calls).toHaveLength(3);
  });

  it('uses a request index.html started, and asks again when that request was a 401', async () => {
    const ok = Promise.resolve({ ok: true, status: 200, statusText: 'ok', json: async () => ({ early: true }) } as Response);
    win.__fdEarly = { '/api/e': ok };
    cache.acquire('/api/e', false)();
    await tick();
    expect(calls).toHaveLength(0);
    expect(cache.peek('/api/e').data).toEqual({ early: true });

    win.__fdEarly = { '/api/f': Promise.resolve({ ok: false, status: 401, statusText: 'no', json: async () => ({}) } as Response) };
    cache.acquire('/api/f', false);
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/f');
  });

  it('setCached replaces the answer for every reader', async () => {
    cache.acquire('/api/x', false)();
    calls[0].resolve({ n: 1 });
    await tick();
    const seen: number[] = [];
    const off = cache.subscribe('/api/x', () => seen.push(cache.peek<{ n: number }>('/api/x').data!.n));
    cache.setCached<{ n: number }>('/api/x', (prev) => ({ n: (prev?.n ?? 0) + 1 }));
    expect(seen).toEqual([2]);
    off();
  });
});
