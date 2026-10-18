import type { OHLCV } from '@/types/market';

export const DAY_MS = 86_400_000;
export const LEVEL_ATR_PERIOD = 14;
/** Within this many daily ATRs of a level, a coin is "near" it. */
export const NEAR_LEVEL_ATR = 0.5;

export interface PriorDayLevels {
  /** Open time (ms, UTC midnight) of the prior UTC day. */
  dayStart: number;
  high: number;
  low: number;
  close: number;
  /** Wilder ATR(14) of completed daily bars, through the prior day. */
  atr: number;
}

export type LevelName = 'high' | 'low' | 'close';

export interface LevelProximity {
  level: LevelName;
  price: number;
  /** (price - level price) / atr: negative means the live price is below the level. */
  distanceAtr: number;
  near: boolean;
}

export function priorDayLevels(
  candles: readonly OHLCV[],
  nowMs: number
): PriorDayLevels | null {
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;

  // Keep only candles with timestamp < todayStart, de-duplicate by timestamp (keep the last)
  const candleMap = new Map<number, OHLCV>();
  for (const candle of candles) {
    if (candle.timestamp < todayStart) {
      candleMap.set(candle.timestamp, candle);
    }
  }

  // Sort ascending by timestamp
  const kept = Array.from(candleMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  // Fewer than 15 kept candles returns null
  if (kept.length < LEVEL_ATR_PERIOD + 1) {
    return null;
  }

  const priorDayStart = todayStart - DAY_MS;
  const priorIndex = kept.findIndex((c) => c.timestamp === priorDayStart);
  if (priorIndex === -1 || priorIndex < LEVEL_ATR_PERIOD) {
    return null;
  }

  const priorCandle = kept[priorIndex];
  if (
    !Number.isFinite(priorCandle.high) ||
    !Number.isFinite(priorCandle.low) ||
    !Number.isFinite(priorCandle.close)
  ) {
    return null;
  }

  // True range TR[j] for j >= 1 over the kept candles
  const tr: number[] = new Array(priorIndex + 1);
  for (let j = 1; j <= priorIndex; j++) {
    const cur = kept[j];
    const prev = kept[j - 1];
    const hl = cur.high - cur.low;
    const hc = Math.abs(cur.high - prev.close);
    const lc = Math.abs(cur.low - prev.close);
    tr[j] = Math.max(hl, hc, lc);
  }

  // Seed ATR[14] = mean(TR[1..14])
  let sumTr = 0;
  for (let j = 1; j <= LEVEL_ATR_PERIOD; j++) {
    sumTr += tr[j];
  }
  let currentAtr = sumTr / LEVEL_ATR_PERIOD;

  // Wilder smoothing: ATR[j] = (13 * ATR[j-1] + TR[j]) / 14
  for (let j = LEVEL_ATR_PERIOD + 1; j <= priorIndex; j++) {
    currentAtr = ((LEVEL_ATR_PERIOD - 1) * currentAtr + tr[j]) / LEVEL_ATR_PERIOD;
  }

  if (!Number.isFinite(currentAtr) || currentAtr <= 0) {
    return null;
  }

  return {
    dayStart: priorCandle.timestamp,
    high: priorCandle.high,
    low: priorCandle.low,
    close: priorCandle.close,
    atr: currentAtr,
  };
}

export function levelProximity(
  price: number,
  levels: PriorDayLevels
): LevelProximity | null {
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }
  if (!Number.isFinite(levels.atr) || levels.atr <= 0) {
    return null;
  }

  const highDist = (price - levels.high) / levels.atr;
  const lowDist = (price - levels.low) / levels.atr;
  const closeDist = (price - levels.close) / levels.atr;

  const candidates: { level: LevelName; distanceAtr: number; absDist: number }[] = [
    { level: 'high', distanceAtr: highDist, absDist: Math.abs(highDist) },
    { level: 'low', distanceAtr: lowDist, absDist: Math.abs(lowDist) },
    { level: 'close', distanceAtr: closeDist, absDist: Math.abs(closeDist) },
  ];

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].absDist < best.absDist) {
      best = candidates[i];
    }
  }

  return {
    level: best.level,
    price,
    distanceAtr: best.distanceAtr,
    near: best.absDist <= NEAR_LEVEL_ATR,
  };
}

export function levelLabel(level: LevelName): string {
  switch (level) {
    case 'high':
      return 'Prev high';
    case 'low':
      return 'Prev low';
    case 'close':
      return 'Prev close';
  }
}
