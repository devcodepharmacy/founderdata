// The noise rule of the verdict (src/worker/note-metrics.ts, docs/API.md "The verdict"): a count must move by twice
// the square root of both counts added, on top of the 10% rule, or the verdict is inconclusive.
import { describe, expect, it } from 'vitest';
import { judge } from '../src/worker/notes';
import { beyondNoise, NOISE_TEXT, rateBeyondNoise } from '../src/worker/note-metrics';

const o = { complete: true, reviewAfter: '2026-11-20T00:00:00.000Z', currency: null as string | null };
const side = (visitors: number, customers = 0, revenue = 0) => ({ visitors, customers, revenue });

describe('the noise rule', () => {
  it('holds two counts apart only past twice the square root of their sum', () => {
    expect(beyondNoise(13, 1)).toBe(true);
    // Trial starts 41 to 47: up 15%, one standard deviation. Visits 100 to 89 down 11%.
    expect(beyondNoise(47, 41)).toBe(false);
    expect(beyondNoise(89, 100)).toBe(false);
    expect(beyondNoise(140, 100)).toBe(true);
    // A rate: the count after against the count before scaled by the sides' sizes. Equal sides read as counts.
    expect(rateBeyondNoise(20, 200, 10, 200)).toBe(beyondNoise(20, 10));
    expect(rateBeyondNoise(20, 200, 10, 200)).toBe(false);
    expect(rateBeyondNoise(25, 200, 10, 200)).toBe(true);
    // Twice the views after and twice the buyers: no change in the rate.
    expect(rateBeyondNoise(40, 400, 20, 200)).toBe(false);
    expect(rateBeyondNoise(5, 100, 0, 0)).toBe(true);
  });

  it('makes a 10% move in visitors inconclusive while it is within normal ups and downs', () => {
    const small = judge(side(120), side(135), o);
    expect(small).toEqual({ verdict: 'inconclusive', verdict_metric: 'visitors', reason: `Visitors rose 13%, from 120 to 135. ${NOISE_TEXT}` });
    expect(judge(side(150), side(120), o)).toMatchObject({ verdict: 'inconclusive', reason: expect.stringMatching(/^Visitors fell 20%, from 150 to 120\. That is within normal ups and downs/) });
    expect(judge(side(1000), side(1200), o)).toMatchObject({ verdict: 'better', reason: 'Visitors rose 20%, from 1,000 to 1,200.' });
    // Under 10% stays the old wording.
    expect(judge(side(1000), side(1050), o).reason).toMatch(/less than the 10% a verdict needs/);
  });

  it('judges the new customers behind a conversion rate the same way, and leaves revenue per visitor to the 10% rule', () => {
    const usd = { ...o, currency: 'USD' };
    // 5 to 8 customers on 1,000 visitors a side: the rate rose 60%, but 8 against 5 is noise.
    expect(judge(side(1000, 5), side(1000, 8), usd)).toMatchObject({ verdict: 'inconclusive', verdict_metric: 'conversion_rate', reason: expect.stringContaining(NOISE_TEXT) });
    expect(judge(side(1000, 10), side(1000, 30), usd)).toMatchObject({ verdict: 'better', verdict_metric: 'conversion_rate' });
    // A price change moves revenue per visitor with the same customers: no count rule.
    expect(judge(side(1000, 10, 10_000), side(1000, 10, 15_000), usd)).toMatchObject({ verdict: 'better', verdict_metric: 'revenue_per_visitor' });
  });
});
