import type { OHLCV } from '@/types/market';
import type { Pivot } from '@/lib/market/structure';

export const CVD_SLOPE_BARS = 20;
export const DIVERGENCE_MAX_BARS = 72;
const DAY_MS = 86_400_000;

export type BarWinner = 'buy' | 'sell' | 'even';

/** Taker buy minus taker sell volume: 2 x takerBuyVolume - volume. Null when takerBuyVolume is missing or not finite, or volume is not finite. */
export function barDelta(candle: OHLCV): number | null {
  if (
    candle.takerBuyVolume === undefined ||
    candle.takerBuyVolume === null ||
    !Number.isFinite(candle.takerBuyVolume) ||
    !Number.isFinite(candle.volume)
  ) {
    return null;
  }
  return 2 * candle.takerBuyVolume - candle.volume;
}

/** 'buy' for delta > 0, 'sell' for < 0, 'even' for 0; null when delta is null. */
export function barWinner(candle: OHLCV): BarWinner | null {
  const delta = barDelta(candle);
  if (delta === null) {
    return null;
  }
  if (delta > 0) {
    return 'buy';
  }
  if (delta < 0) {
    return 'sell';
  }
  return 'even';
}

export interface CvdPoint {
  timestamp: number;
  cvd: number | null;
}

/**
 * Running sum of barDelta. With resetDaily, the sum restarts at every bar whose timestamp is a UTC midnight
 * (timestamp % 86_400_000 === 0), so that bar's CVD equals its own delta. A null delta makes that point's cvd null
 * and the running sum carries on unchanged from the last non-null point.
 */
export function cvdSeries(
  candles: readonly OHLCV[],
  opts: { resetDaily: boolean }
): CvdPoint[] {
  const points: CvdPoint[] = [];
  let runningSum = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const isMidnight = opts.resetDaily && candle.timestamp % DAY_MS === 0;
    if (isMidnight) {
      runningSum = 0;
    }

    const delta = barDelta(candle);
    if (delta === null) {
      points.push({ timestamp: candle.timestamp, cvd: null });
    } else {
      runningSum += delta;
      points.push({ timestamp: candle.timestamp, cvd: runningSum });
    }
  }

  return points;
}

/** 'rising' if cvd[last] > cvd[last - bars], 'falling' if <, 'flat' if equal; null if either point is null, missing, or a daily reset lies between them. */
export function cvdSlope(
  points: readonly CvdPoint[],
  bars?: number
): 'rising' | 'falling' | 'flat' | null {
  const period = bars ?? CVD_SLOPE_BARS;
  if (!Number.isInteger(period) || period <= 0) {
    return null;
  }

  if (points.length < period + 1) {
    return null;
  }

  const lastIdx = points.length - 1;
  const firstIdx = lastIdx - period;
  const firstPoint = points[firstIdx];
  const lastPoint = points[lastIdx];

  if (!firstPoint || !lastPoint) {
    return null;
  }
  if (firstPoint.cvd === null || lastPoint.cvd === null) {
    return null;
  }

  // A daily reset lies between first and last if midnight occurs in (firstIdx, lastIdx]
  // or if first and last fall on different UTC days.
  const firstDay = Math.floor(firstPoint.timestamp / DAY_MS);
  const lastDay = Math.floor(lastPoint.timestamp / DAY_MS);
  if (firstDay !== lastDay) {
    return null;
  }

  for (let i = firstIdx + 1; i <= lastIdx; i++) {
    if (points[i].timestamp % DAY_MS === 0) {
      return null;
    }
  }

  if (lastPoint.cvd > firstPoint.cvd) {
    return 'rising';
  }
  if (lastPoint.cvd < firstPoint.cvd) {
    return 'falling';
  }
  return 'flat';
}

export type DivergenceKind = 'regular' | 'hidden';

export interface DeltaDivergence {
  kind: DivergenceKind;
  direction: 'bull' | 'bear'; // bear: price up, flow down (regular) / the mirror rules below
  first: Pivot;
  second: Pivot;
  summedDelta: number; // sum of barDelta over (first.index, second.index], i.e. first.index + 1 .. second.index
  confirmedIndex: number; // second.confirmedIndex
}

/**
 * For each pair of CONSECUTIVE pivots of the same kind (in index order) with second.index - first.index <= maxBars,
 * and with every barDelta in (first.index, second.index] non-null:
 * - highs, regular bear:  second.price > first.price and summedDelta < 0
 * - highs, hidden bear:   second.price < first.price and summedDelta > 0
 * - lows,  regular bull:  second.price < first.price and summedDelta > 0
 * - lows,  hidden bull:   second.price > first.price and summedDelta < 0
 * Equal prices or summedDelta === 0 give nothing. Results sorted by confirmedIndex, then highs before lows.
 */
export function deltaDivergences(
  candles: readonly OHLCV[],
  pivots: readonly Pivot[],
  maxBars?: number
): DeltaDivergence[] {
  const limit = maxBars ?? DIVERGENCE_MAX_BARS;
  if (!Number.isInteger(limit) || limit <= 0) {
    return [];
  }

  const highs = pivots
    .filter((p) => p.kind === 'high')
    .slice()
    .sort((a, b) => a.index - b.index);

  const lows = pivots
    .filter((p) => p.kind === 'low')
    .slice()
    .sort((a, b) => a.index - b.index);

  const divergences: DeltaDivergence[] = [];

  const checkPair = (first: Pivot, second: Pivot): void => {
    const span = second.index - first.index;
    if (span <= 0 || span > limit) {
      return;
    }

    let summedDelta = 0;
    for (let k = first.index + 1; k <= second.index; k++) {
      const candle = candles[k];
      if (!candle) {
        return;
      }
      const d = barDelta(candle);
      if (d === null) {
        return;
      }
      summedDelta += d;
    }

    if (second.price === first.price || summedDelta === 0) {
      return;
    }

    if (first.kind === 'high') {
      if (second.price > first.price && summedDelta < 0) {
        divergences.push({
          kind: 'regular',
          direction: 'bear',
          first,
          second,
          summedDelta,
          confirmedIndex: second.confirmedIndex,
        });
      } else if (second.price < first.price && summedDelta > 0) {
        divergences.push({
          kind: 'hidden',
          direction: 'bear',
          first,
          second,
          summedDelta,
          confirmedIndex: second.confirmedIndex,
        });
      }
    } else {
      if (second.price < first.price && summedDelta > 0) {
        divergences.push({
          kind: 'regular',
          direction: 'bull',
          first,
          second,
          summedDelta,
          confirmedIndex: second.confirmedIndex,
        });
      } else if (second.price > first.price && summedDelta < 0) {
        divergences.push({
          kind: 'hidden',
          direction: 'bull',
          first,
          second,
          summedDelta,
          confirmedIndex: second.confirmedIndex,
        });
      }
    }
  };

  for (let i = 0; i < highs.length - 1; i++) {
    checkPair(highs[i], highs[i + 1]);
  }

  for (let i = 0; i < lows.length - 1; i++) {
    checkPair(lows[i], lows[i + 1]);
  }

  divergences.sort((a, b) => {
    if (a.confirmedIndex !== b.confirmedIndex) {
      return a.confirmedIndex - b.confirmedIndex;
    }
    if (a.second.kind !== b.second.kind) {
      return a.second.kind === 'high' ? -1 : 1;
    }
    return a.first.index - b.first.index;
  });

  return divergences;
}
