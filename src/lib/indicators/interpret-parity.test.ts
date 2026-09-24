// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { computeAllIndicators } from './compute';
import { interpretIndicators } from './interpret';
import { interpretIndicatorsAtBar } from './interpret-at-bar';
import type { OHLCV } from '@/types/market';

/**
 * The live scorer and the research path must read the same bar the same way.
 *
 * `interpretIndicators` (live, via compute-engine) and
 * `interpretIndicatorsAtBar` (backtest, research, and everything that produced
 * the percentile tables in calibration.ts) are two implementations of one
 * interpretation. They silently disagreed: the live one derived `close` from
 * `raw.ema12.values[length - 1]`, which is `ema12.current` under another name,
 * so `interpretEMACross`'s `close > ema12` compared a number to itself and was
 * permanently false -- scoring every bullish EMA reading at 60% of an identical
 * bearish one -- while interpretSMATrend, interpretIchimoku and interpretATR
 * were handed EMA(fast) where they expect the close.
 *
 * Nothing in the suite caught that, because nothing compared the two paths.
 * This file is that comparison.
 */

function generateCandles(count: number, startPrice = 100, seed = 42): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = startPrice;
  let rng = seed;

  function nextRandom(): number {
    rng = (rng * 16807 + 0) % 2147483647;
    return rng / 2147483647;
  }

  for (let i = 0; i < count; i++) {
    const change = (nextRandom() - 0.48) * 2;
    price = price * (1 + change / 100);
    const high = price * (1 + nextRandom() * 0.01);
    const low = price * (1 - nextRandom() * 0.01);
    const open = price * (1 + (nextRandom() - 0.5) * 0.005);
    const volume = 1000 + nextRandom() * 5000;

    candles.push({ timestamp: 1700000000000 + i * 3600000, open, high, low, close: price, volume });
  }

  return candles;
}

/** Signals whose reading depends on the close, so they are the ones that diverged. */
const CLOSE_DEPENDENT = ['EMA Cross', 'SMA Trend', 'Ichimoku', 'ATR'];

function byName(signals: { name: string; direction: string; strength: number }[]) {
  return new Map(signals.map((s) => [s.name, s]));
}

describe('interpretIndicators parity with interpretIndicatorsAtBar', () => {
  // Several seeds, because the asymmetry only shows on bars where the close sits
  // on one particular side of EMA(fast); a single seed can miss it.
  it.each([42, 7, 1234, 98765])(
    'agrees on every close-dependent trend signal at the last bar (seed %i)',
    (seed) => {
      const candles = generateCandles(300, 100, seed);
      const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');
      const lastIndex = candles.length - 1;

      const live = byName(interpretIndicators(raw).signals.trend);
      const atBar = byName(interpretIndicatorsAtBar(raw, lastIndex, candles).signals.trend);

      for (const name of CLOSE_DEPENDENT) {
        const a = live.get(name);
        const b = atBar.get(name);
        if (!a || !b) continue; // Ichimoku is absent for some styles/configs.

        expect(a.direction, `${name} direction`).toBe(b.direction);
        expect(a.strength, `${name} strength`).toBeCloseTo(b.strength, 6);
      }
    }
  );

  it('reads the real close, not EMA(fast)', () => {
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');

    // The regression in one assertion: lastClose must be the bar's close, and
    // must not be the value it is compared against.
    expect(raw.lastClose).toBe(candles[candles.length - 1].close);
    expect(raw.lastClose).not.toBe(raw.ema12.current);
  });

  it('does not penalise a bullish EMA cross relative to an identical bearish one', () => {
    // `aboveEma ? strength : strength * 0.6` is legitimate weighting, but it
    // must respond to where the close actually is. With close === ema12 it was
    // stuck on the 0.6 branch for every bullish reading, a standing directional
    // bias in the highest-weighted category for three of four styles.
    const candles = generateCandles(300);
    const raw = computeAllIndicators(candles, 'BTCUSDT', '1h');

    const above = interpretIndicators({ ...raw, lastClose: raw.ema12.current * 1.05 });
    const below = interpretIndicators({ ...raw, lastClose: raw.ema12.current * 0.95 });

    const a = byName(above.signals.trend).get('EMA Cross')!;
    const b = byName(below.signals.trend).get('EMA Cross')!;

    // Same underlying cross, so same direction; only the close moved.
    expect(a.direction).toBe(b.direction);
    // And the strength must differ, which is what proves the flag is now live.
    expect(a.strength).not.toBe(b.strength);
  });
});
