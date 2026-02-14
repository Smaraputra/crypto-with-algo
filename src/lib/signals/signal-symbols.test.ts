import { describe, it, expect } from 'vitest';

import { SIGNAL_SYMBOLS } from './signal-symbols';

describe('SIGNAL_SYMBOLS', () => {
  it('contains 10 symbols', () => {
    expect(SIGNAL_SYMBOLS).toHaveLength(10);
  });

  it('all symbols end with USDT', () => {
    for (const symbol of SIGNAL_SYMBOLS) {
      expect(symbol).toMatch(/USDT$/);
    }
  });

  it('includes major cryptos', () => {
    expect(SIGNAL_SYMBOLS).toContain('BTCUSDT');
    expect(SIGNAL_SYMBOLS).toContain('ETHUSDT');
    expect(SIGNAL_SYMBOLS).toContain('SOLUSDT');
  });

  it('has no duplicates', () => {
    const unique = new Set(SIGNAL_SYMBOLS);
    expect(unique.size).toBe(SIGNAL_SYMBOLS.length);
  });
});
