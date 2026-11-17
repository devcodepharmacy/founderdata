import { describe, expect, it } from 'vitest';
import { changeView, fmtDuration } from '../src/dashboard/lib/format';

// The comparison under each tile: never "Infinity%" or "NaN", and "no data before" when nothing was measured.
describe('changeView: the comparison under a tile', () => {
  it('shows the absolute change from a zero, never a percentage', () => {
    expect(changeView(12, 0)).toEqual({ kind: 'abs', up: true, text: '+12 ↑' });
    expect(changeView(35, 0, { fmt: (n) => `${n} pts` })).toEqual({ kind: 'abs', up: true, text: '+35 pts ↑' });
    expect(changeView(0, 0)).toEqual({ kind: 'none', text: 'no change' });
  });

  it('says "no data before" when the previous period measured nothing', () => {
    expect(changeView(0.4, 0, { noData: true })).toEqual({ kind: 'noData', text: 'no data before' });
    expect(changeView(60_000, 0, { noData: true, fmt: fmtDuration }).text).toBe('no data before');
    expect(changeView(NaN, 3).text).toBe('no data before');
    expect(changeView(3, Infinity).text).toBe('no data before');
  });

  it('uses a percentage on a real base and the count on a small one', () => {
    expect(changeView(150, 100, { minBase: 20 })).toEqual({ kind: 'pct', up: true, text: '50% ↑' });
    expect(changeView(5, 3, { minBase: 20 })).toEqual({ kind: 'abs', up: true, text: '+2 ↑' });
    expect(changeView(40, 100)).toEqual({ kind: 'pct', up: false, text: '60% ↓' });
    for (const [c, p] of [[1, 0], [0, 0], [5, 0.0001], [-3, 0]]) expect(changeView(c, p).text).not.toMatch(/Infinity|NaN/);
  });
});
