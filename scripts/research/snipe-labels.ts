/**
 * Snipe phase trade labels (see snipe.ts, TRADE AND LABEL). Pure, no I/O.
 *
 * For every condition bar t of the entry-timeframe series: entry at bar t+1's open, barriers entry +/- barrierAtr x ATR
 * with ATR = Wilder ATR(atrPeriod) through bar t-1, then the 5m path is walked from the entry for at most maxHoldMs.
 *
 * Rules:
 *   - none: no bar t+1, a gap between t and t+1, ATR not finite or <= 0, or the trade window would end after sliceEndMs.
 *   - A path candle with high >= upper and low <= lower is AMBIGUOUS, high >= upper is UP, low <= lower is DOWN
 *     (a touch counts). The first deciding candle ends the trade at its open time + 5 minutes.
 *   - No decision in [entry, entry + maxHoldMs) is TIMEOUT, exit = entry + maxHoldMs. Missing path candles are skipped.
 *   - Cost is O(entries + path rows): the path pointer only moves forward while entry times increase.
 */
import type { OHLCV } from '@/types/market';
import { atr } from './families/legends-indicators';

export const OUTCOME_NONE = 0;
export const OUTCOME_UP = 1;
export const OUTCOME_DOWN = 2;
export const OUTCOME_TIMEOUT = 3;
export const OUTCOME_AMBIGUOUS = 4;

export const PATH_INTERVAL_MS = 5 * 60_000;

/** Wilder ATR(period) of `bars`; NaN before index `period` (true range starts at index 1). */
export function wilderAtr(bars: readonly OHLCV[], period: number): Float64Array {
  return atr(bars, period);
}

export interface LabelInput {
  entryBars: readonly OHLCV[];
  entryIntervalMs: number;
  pathBars: readonly OHLCV[];
  maxHoldMs: number;
  atrPeriod: number;
  barrierAtr: number;
  /** Inclusive end of the slice, ms. */
  sliceEndMs: number;
}

export interface EntryLabels {
  outcome: Int8Array;
  exitMs: Float64Array;
  entryMs: Float64Array;
  atrPct: Float64Array;
}

/** First index in `bars` with timestamp >= ms, searching from `from`. */
function lowerBound(bars: readonly OHLCV[], ms: number, from: number): number {
  let lo = from;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].timestamp < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function labelEntries(input: LabelInput): EntryLabels {
  const { entryBars, entryIntervalMs, pathBars, maxHoldMs, atrPeriod, barrierAtr, sliceEndMs } = input;
  const n = entryBars.length;
  const outcome = new Int8Array(n);
  const exitMs = new Float64Array(n).fill(Number.NaN);
  const entryMs = new Float64Array(n).fill(Number.NaN);
  const atrPct = new Float64Array(n).fill(Number.NaN);
  const atrSeries = wilderAtr(entryBars, atrPeriod);
  let pathFrom = 0;

  for (let t = 1; t + 1 < n; t++) {
    const next = entryBars[t + 1];
    if (next.timestamp !== entryBars[t].timestamp + entryIntervalMs) continue;
    const a = atrSeries[t - 1];
    if (!Number.isFinite(a) || a <= 0) continue;
    const entryTime = next.timestamp;
    const windowEnd = entryTime + maxHoldMs;
    if (windowEnd - 1 > sliceEndMs) continue;

    const entry = next.open;
    const upper = entry + barrierAtr * a;
    const lower = entry - barrierAtr * a;
    // Entry times increase with t, so the pointer never needs to move back.
    pathFrom = lowerBound(pathBars, entryTime, pathFrom);

    let code = OUTCOME_TIMEOUT;
    let exit = windowEnd;
    for (let k = pathFrom; k < pathBars.length && pathBars[k].timestamp < windowEnd; k++) {
      const c = pathBars[k];
      const hitUp = c.high >= upper;
      const hitDown = c.low <= lower;
      if (!hitUp && !hitDown) continue;
      code = hitUp && hitDown ? OUTCOME_AMBIGUOUS : hitUp ? OUTCOME_UP : OUTCOME_DOWN;
      exit = c.timestamp + PATH_INTERVAL_MS;
      break;
    }
    outcome[t] = code;
    exitMs[t] = exit;
    entryMs[t] = entryTime;
    atrPct[t] = (a / entryBars[t - 1].close) * 100;
  }
  return { outcome, exitMs, entryMs, atrPct };
}
