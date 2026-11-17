import { describe, expect, it } from 'vitest';
import { newerRelease, parseRelease } from '../src/dashboard/lib/updates';

describe('update check', () => {
  it('parses a release file', () => {
    expect(parseRelease('{"version":"1.2.0","date":"2026-12-01","notes":"Faster."}')).toEqual({ version: '1.2.0', date: '2026-12-01', notes: 'Faster.' });
    expect(parseRelease('{"version":"1.2.0"}')).toEqual({ version: '1.2.0', date: '', notes: undefined });
  });

  it('rejects an answer that is not a release', () => {
    expect(parseRelease('<html>404: Not Found</html>')).toBeNull();
    expect(parseRelease('null')).toBeNull();
    expect(parseRelease('{"date":"2026-12-01"}')).toBeNull();
    expect(parseRelease('{"version":"latest"}')).toBeNull();
    expect(parseRelease('{"version":2}')).toBeNull();
  });

  it('offers only a newer version', () => {
    const r = (version: string) => ({ version, date: '' });
    expect(newerRelease('1.0.0', r('1.0.1'))?.version).toBe('1.0.1');
    expect(newerRelease('1.9.0', r('1.10.0'))?.version).toBe('1.10.0');
    expect(newerRelease('1.0.0', r('1.0.0'))).toBeNull();
    expect(newerRelease('2.0.0', r('1.9.9'))).toBeNull();
  });
});
