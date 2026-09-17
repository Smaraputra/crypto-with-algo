import { describe, expect, it } from 'vitest';

import { OUTCOME_HORIZON_BARS, resolveAtFor } from './outcome-horizons';

describe('OUTCOME_HORIZON_BARS', () => {
  it('defines a horizon in bars for every trading style', () => {
    expect(OUTCOME_HORIZON_BARS).toEqual({
      scalping: 12,
      day_trading: 24,
      swing_trading: 30,
      position_trading: 20,
    });
  });
});

describe('resolveAtFor', () => {
  it('adds one extra bar beyond the horizon so the horizon bar has closed', () => {
    const candleTimestamp = 1_700_000_000_000;
    const oneHourMs = 60 * 60 * 1000;

    const resolveAt = resolveAtFor(candleTimestamp, '1h', 24);

    expect(resolveAt).toBe(candleTimestamp + 25 * oneHourMs);
  });

  it('scales with the interval size', () => {
    const candleTimestamp = 1_700_000_000_000;
    const fiveMinMs = 5 * 60 * 1000;

    const resolveAt = resolveAtFor(candleTimestamp, '5m', 12);

    expect(resolveAt).toBe(candleTimestamp + 13 * fiveMinMs);
  });

  it('throws for an unknown interval', () => {
    expect(() => resolveAtFor(1_700_000_000_000, '2h', 10)).toThrow();
  });
});
