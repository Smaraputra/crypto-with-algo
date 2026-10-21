import type { OHLCV } from '@/types/market';
import {
  analyzeStructure,
  SWING_LENGTH,
  type StructureEvent,
  type Trend,
} from './structure';
import {
  CVD_SLOPE_BARS,
  cvdSeries,
  cvdSlope,
} from './delta';

export const MTF_INTERVALS = ['15m', '1h', '4h', '1d'] as const;
export type MtfInterval = (typeof MTF_INTERVALS)[number];
export const MTF_SMA_LENGTH = 50;
export const MTF_INTERVAL_MS: Record<MtfInterval, number> = {
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface MtfState {
  interval: MtfInterval;
  /** Open time of the last CLOSED bar used, null when there is none. */
  asOf: number | null;
  trend: Trend;                         // analyzeStructure(closed, SWING_LENGTH).trend
  lastEvent: StructureEvent | null;     // the last swing event, or null
  cvdSlope: 'rising' | 'falling' | 'flat' | null; // cvdSlope(cvdSeries(closed, { resetDaily: false }), CVD_SLOPE_BARS)
  priceVsSma: 'above' | 'below' | null; // last close vs the simple mean of the last MTF_SMA_LENGTH closes; null with fewer bars; equal counts as 'above'
}

/** Drops bars that have not closed at nowMs: a bar is closed when timestamp + intervalMs <= nowMs. Keeps order. */
export function closedBars(
  candles: readonly OHLCV[],
  interval: MtfInterval,
  nowMs: number
): OHLCV[] {
  const intervalMs = MTF_INTERVAL_MS[interval];
  return candles.filter((candle) => candle.timestamp + intervalMs <= nowMs);
}

/** State of one timeframe from candles that may include a forming bar (it is dropped first). */
export function mtfState(
  interval: MtfInterval,
  candles: readonly OHLCV[],
  nowMs: number
): MtfState {
  const closed = closedBars(candles, interval, nowMs);
  const asOf = closed.length > 0 ? closed[closed.length - 1].timestamp : null;

  const struct = analyzeStructure(closed, SWING_LENGTH);
  const lastEvent =
    struct.events.length > 0 ? struct.events[struct.events.length - 1] : null;

  const cvd = cvdSeries(closed, { resetDaily: false });
  const slope = cvdSlope(cvd, CVD_SLOPE_BARS);

  let priceVsSma: 'above' | 'below' | null = null;
  if (closed.length >= MTF_SMA_LENGTH) {
    let sum = 0;
    const startIdx = closed.length - MTF_SMA_LENGTH;
    for (let i = startIdx; i < closed.length; i++) {
      sum += closed[i].close;
    }
    const sma = sum / MTF_SMA_LENGTH;
    const lastClose = closed[closed.length - 1].close;
    priceVsSma = lastClose >= sma ? 'above' : 'below';
  }

  return {
    interval,
    asOf,
    trend: struct.trend,
    lastEvent,
    cvdSlope: slope,
    priceVsSma,
  };
}
