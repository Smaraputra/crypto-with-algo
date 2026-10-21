import { describe, expect, it } from 'vitest';
import { formatAge } from './format';

describe('formatAge', () => {
  const now = 1_700_000_000_000;

  it('formats seconds below 60 as just now', () => {
    expect(formatAge(now - 30_000, now)).toBe('just now');
    expect(formatAge(now, now)).toBe('just now');
    expect(formatAge(now - 59_000, now)).toBe('just now');
  });

  it('formats minutes up to 59m ago', () => {
    expect(formatAge(now - 60_000, now)).toBe('1m ago');
    expect(formatAge(now - 120_000, now)).toBe('2m ago');
    expect(formatAge(now - 59 * 60_000, now)).toBe('59m ago');
  });

  it('formats hours up to 23h ago', () => {
    expect(formatAge(now - 60 * 60_000, now)).toBe('1h ago');
    expect(formatAge(now - 2 * 60 * 60_000, now)).toBe('2h ago');
    expect(formatAge(now - 23 * 60 * 60_000, now)).toBe('23h ago');
  });

  it('formats days for 24h and beyond', () => {
    expect(formatAge(now - 24 * 60 * 60_000, now)).toBe('1d ago');
    expect(formatAge(now - 72 * 60 * 60_000, now)).toBe('3d ago');
  });

  it('handles seconds unix timestamp', () => {
    const nowSec = 1_700_000_000;
    expect(formatAge(nowSec - 120, now)).toBe('2m ago');
  });

  it('handles ISO strings and Date objects', () => {
    const iso = new Date(now - 3_600_000).toISOString();
    expect(formatAge(iso, now)).toBe('1h ago');
    expect(formatAge(new Date(now - 7_200_000), now)).toBe('2h ago');
  });

  it('returns n/a for null, undefined, or invalid input', () => {
    expect(formatAge(null, now)).toBe('n/a');
    expect(formatAge(undefined, now)).toBe('n/a');
    expect(formatAge('invalid-date', now)).toBe('n/a');
  });
});
