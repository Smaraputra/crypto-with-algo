import type { OHLCV } from '@/types/market';
import { intervalToMs } from '@/lib/intervals';

/**
 * Deterministic inputs for scoring tests: a seeded PRNG (no Math.random), a
 * random-walk candle builder, stored-snapshot rows shaped like the lean
 * documents `HistoricalSnapshot.find(...).lean()` returns, and one fixed
 * "now". Used by the scheduler golden test and reusable by later tasks.
 */

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FOUR_HOURS_MS = 4 * 3_600_000;

/**
 * 2026-10-09T08:00:00Z is a 4h boundary; the instant is seven minutes later,
 * so the 5m, 1h and 4h bars that closed at the boundary are all just closed
 * and the bars opening at the boundary are still forming.
 */
export const FIXED_NOW = Date.UTC(2026, 9, 9, 8, 7, 0, 0);

if (FIXED_NOW % FOUR_HOURS_MS !== 7 * 60_000) {
  throw new Error('FIXED_NOW must sit seven minutes after a 4h boundary');
}

/** Open time of the most recent bar that has closed at `now` for an interval. */
export function lastClosedOpenTime(interval: string, now: number = FIXED_NOW): number {
  const ms = intervalToMs(interval);
  return Math.floor(now / ms) * ms - ms;
}

/** A stable per-input seed so each (symbol, interval) gets its own series. */
export function seedFor(...parts: Array<string | number>): number {
  let h = 2166136261;
  for (const ch of parts.join(':')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function buildCandles(opts: {
  symbol: string;
  interval: string;
  count: number;
  endOpenTime: number;
  seed: number;
  startPrice?: number;
}): OHLCV[] {
  const { count, endOpenTime, interval } = opts;
  const step = intervalToMs(interval);
  const rng = mulberry32(opts.seed);
  const candles: OHLCV[] = [];
  let price = opts.startPrice ?? 100;
  // Slowly flipping drift so the series has trends, not just noise.
  let drift = 0;

  for (let i = 0; i < count; i++) {
    if (i % 40 === 0) drift = (rng() - 0.5) * 0.004;
    const open = price;
    const ret = drift + (rng() - 0.5) * 0.012;
    const close = open * (1 + ret);
    const high = Math.max(open, close) * (1 + rng() * 0.004);
    const low = Math.min(open, close) * (1 - rng() * 0.004);
    const volume = 500 + rng() * 1500;
    candles.push({
      timestamp: endOpenTime - (count - 1 - i) * step,
      open,
      high,
      low,
      close,
      volume,
      takerBuyVolume: volume * (0.2 + rng() * 0.6),
    });
    price = close;
  }
  return candles;
}

export interface FixtureSnapshotRow {
  timestamp: number;
  data: {
    fundingRate: { rate: number; markPrice: number };
    longShortRatio: { ratio: number; longAccount: number; shortAccount: number };
  };
}

/**
 * One row per `snapshotInterval` from `from` to `to` inclusive (stamps aligned
 * to the interval), with a drifting funding rate and a moving long/short ratio
 * so the 30-day trailing z is defined and varies.
 */
export function buildSnapshotRows(opts: {
  symbol: string;
  snapshotInterval: string;
  from: number;
  to: number;
  seed: number;
}): FixtureSnapshotRow[] {
  const step = intervalToMs(opts.snapshotInterval);
  const rng = mulberry32(opts.seed);
  const rows: FixtureSnapshotRow[] = [];
  const first = Math.ceil(opts.from / step) * step;
  let ratio = 1.5;
  let k = 0;
  for (let t = first; t <= opts.to; t += step, k++) {
    ratio = Math.max(0.6, ratio + (1.5 + 0.4 * Math.sin(k / 30) - ratio) * 0.2 + (rng() - 0.5) * 0.1);
    const longAccount = ratio / (1 + ratio);
    rows.push({
      timestamp: t,
      data: {
        fundingRate: { rate: 0.0001 + (rng() - 0.4) * 0.0004, markPrice: 100 },
        longShortRatio: { ratio, longAccount, shortAccount: 1 - longAccount },
      },
    });
  }
  return rows;
}

/** Latest stored news aggregate per symbol, as the aggregate pipeline returns it. */
export const NEWS_AGGREGATE_ROWS = [
  { _id: 'BTCUSDT', newsSentiment: { count: 8, avgSentiment: 0.42, topics: ['etf'] } },
  { _id: 'ETHUSDT', newsSentiment: { count: 5, avgSentiment: -0.31, topics: ['defi'] } },
];

export const FIXTURE_FEAR_GREED = { fearGreedIndex: 27, label: 'Fear' };
