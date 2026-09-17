// @vitest-environment node
// Regression guard for the annualization/expectancy change (task B1). The
// fixture was captured from the engine at the commit before this change, on
// the same deterministic series used here. Trades, equityCurve, and every
// metric except sharpeRatio and sortinoRatio (which change by design; see
// metrics.test.ts for their formula coverage) must stay byte-for-byte equal.
import { describe, it, expect } from 'vitest';
import { runBacktest } from './engine';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { OHLCV } from '@/types/market';
import golden from '@/__fixtures__/backtest-golden.json';

// Deterministic random walk with trend, seeded LCG (same pattern as engine.test.ts
// and engine-parity.test.ts; kept in sync with the generator used to produce
// src/__fixtures__/backtest-golden.json).
function generateCandles(count: number, seed = 123): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = 100;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    // Alternate trend regimes so both long and short entries occur
    const drift = i < count / 2 ? 0.002 : -0.002;
    const noise = (nextRandom() - 0.5) * 0.5;
    price = price * (1 + drift + noise / 100);
    const high = price * (1 + nextRandom() * 0.005);
    const low = price * (1 - nextRandom() * 0.005);
    const open = price * (1 + (nextRandom() - 0.5) * 0.003);
    const volume = 1000 + nextRandom() * 5000;

    candles.push({
      timestamp: 1700000000000 + i * 3600000,
      open,
      high,
      low,
      close: price,
      volume,
      takerBuyVolume: volume * (0.3 + nextRandom() * 0.4),
    });
  }

  return candles;
}

/** Drop any key from `actual` that `reference` does not have, so fields added
 * after the fixture was captured (e.g. riskPercent) don't break the diff. */
function stripKeysNotIn<T extends Record<string, unknown>>(
  actual: T,
  reference: Record<string, unknown>
): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(actual) as Array<keyof T>) {
    if (Object.prototype.hasOwnProperty.call(reference, key)) {
      result[key] = actual[key];
    }
  }
  return result;
}

describe('golden regression: engine output vs pre-annualization-fix fixture', () => {
  it('keeps trades, equityCurve, and non-annualized metrics unchanged', () => {
    const candles = generateCandles(600);
    const config = { ...DEFAULT_BACKTEST_CONFIG, allowShorts: true };
    const result = runBacktest(candles, config, 'BTCUSDT', '1h');

    const fixtureTrades = golden.trades as Array<Record<string, unknown>>;
    const actualTrades = result.trades.map((trade, i) =>
      stripKeysNotIn(trade as unknown as Record<string, unknown>, fixtureTrades[i])
    );
    expect(actualTrades).toEqual(fixtureTrades);

    expect(result.equityCurve).toEqual(golden.equityCurve);

    const fixtureMetrics = golden.metrics as Record<string, unknown>;
    const actualMetrics = result.metrics as unknown as Record<string, unknown>;
    for (const key of Object.keys(fixtureMetrics)) {
      if (key === 'sharpeRatio' || key === 'sortinoRatio') continue;
      expect(actualMetrics[key]).toEqual(fixtureMetrics[key]);
    }
  });
});
