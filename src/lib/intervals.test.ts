import { describe, it, expect } from 'vitest';
import { intervalToMs } from './intervals';

describe('intervalToMs', () => {
  it('maps all supported intervals', () => {
    expect(intervalToMs('1m')).toBe(60 * 1000);
    expect(intervalToMs('5m')).toBe(5 * 60 * 1000);
    expect(intervalToMs('15m')).toBe(15 * 60 * 1000);
    expect(intervalToMs('1h')).toBe(60 * 60 * 1000);
    expect(intervalToMs('4h')).toBe(4 * 60 * 60 * 1000);
    expect(intervalToMs('1d')).toBe(24 * 60 * 60 * 1000);
  });

  it('throws for unknown intervals', () => {
    expect(() => intervalToMs('1w')).toThrow('Unknown interval: 1w');
    expect(() => intervalToMs('')).toThrow('Unknown interval: ');
  });
});
