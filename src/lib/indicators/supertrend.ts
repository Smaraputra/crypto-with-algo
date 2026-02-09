import { ATR } from 'technicalindicators';

import type { OHLCV } from '@/types/market';

export interface SuperTrendResult {
  values: SuperTrendPoint[];
  current: SuperTrendPoint;
}

export interface SuperTrendPoint {
  supertrend: number;
  direction: 'up' | 'down'; // 'up' = bullish (price above), 'down' = bearish
  upperBand: number;
  lowerBand: number;
}

/**
 * Compute SuperTrend indicator.
 *
 * SuperTrend = ATR-based trailing stop that flips direction on trend reversal.
 * - When price closes above the upper band, trend flips bullish (direction = 'up')
 * - When price closes below the lower band, trend flips bearish (direction = 'down')
 *
 * Band calculation:
 *   HL2 = (high + low) / 2
 *   Upper = HL2 + (multiplier * ATR)
 *   Lower = HL2 - (multiplier * ATR)
 *
 * Bands ratchet: upper band can only decrease, lower band can only increase
 * (unless trend flips).
 */
export function computeSuperTrend(
  candles: OHLCV[],
  period = 10,
  multiplier = 3
): SuperTrendResult {
  if (candles.length < period + 1) {
    throw new Error(
      `SuperTrend needs at least ${period + 1} candles, got ${candles.length}`
    );
  }

  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);

  const atrValues = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period,
  });

  // ATR output starts at index (period), so we align:
  // atrValues[0] corresponds to candles[period]
  const offset = candles.length - atrValues.length;

  const results: SuperTrendPoint[] = [];
  let prevUpperBand = Infinity;
  let prevLowerBand = -Infinity;
  let prevDirection: 'up' | 'down' = 'up';
  let prevClose = closes[offset - 1];

  for (let i = 0; i < atrValues.length; i++) {
    const candleIdx = offset + i;
    const hl2 = (highs[candleIdx] + lows[candleIdx]) / 2;
    const atr = atrValues[i];
    const close = closes[candleIdx];

    // Basic bands
    let upperBand = hl2 + multiplier * atr;
    let lowerBand = hl2 - multiplier * atr;

    // Ratchet: upper band can only decrease (tighten), lower band can only increase
    if (upperBand < prevUpperBand || prevClose > prevUpperBand) {
      // Use new upper band
    } else {
      upperBand = prevUpperBand;
    }

    if (lowerBand > prevLowerBand || prevClose < prevLowerBand) {
      // Use new lower band
    } else {
      lowerBand = prevLowerBand;
    }

    // Determine direction
    let direction: 'up' | 'down';
    if (prevDirection === 'up') {
      direction = close < lowerBand ? 'down' : 'up';
    } else {
      direction = close > upperBand ? 'up' : 'down';
    }

    const supertrend = direction === 'up' ? lowerBand : upperBand;

    results.push({ supertrend, direction, upperBand, lowerBand });

    prevUpperBand = upperBand;
    prevLowerBand = lowerBand;
    prevDirection = direction;
    prevClose = close;
  }

  return {
    values: results,
    current: results[results.length - 1],
  };
}
