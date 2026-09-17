import { describe, it, expect } from 'vitest';
import { intervalToMs, barsPerYear } from './intervals';

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

describe('barsPerYear', () => {
  it('derives bars per year from interval duration (365-day crypto year)', () => {
    expect(barsPerYear('1m')).toBe(525600);
    expect(barsPerYear('5m')).toBe(105120);
    expect(barsPerYear('15m')).toBe(35040);
    expect(barsPerYear('1h')).toBe(8760);
    expect(barsPerYear('4h')).toBe(2190);
    expect(barsPerYear('1d')).toBe(365);
  });

  it('throws for unknown intervals', () => {
    expect(() => barsPerYear('1w')).toThrow('Unknown interval: 1w');
  });
});
