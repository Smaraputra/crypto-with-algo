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
 *
 * Sanity data (AMENDMENT 1, A1-5), for hand-checking labels against the raw candles: `entryPrice` (the entry bar's
 * open) and `atrAbs` (ATR in price units; atrPct = atrAbs / close(t-1) x 100), NaN where outcome is NONE, and `gap`,
 * 1 when the label rests on a hole in the data: any consecutive pair of entry bars inside the ATR window
 * [t - atrPeriod, t] that is not exactly one interval apart, or fewer 5m path candles than the walk needed (a timed
 * out trade needs maxHoldMs / 5 min of them, a decided one the candles from the entry through the deciding one).
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
  entryPrice: Float64Array;
  atrAbs: Float64Array;
  gap: Uint8Array;
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
  const entryPrice = new Float64Array(n).fill(Number.NaN);
  const atrAbs = new Float64Array(n).fill(Number.NaN);
  const gap = new Uint8Array(n);
  // brokenBefore[k] = number of consecutive entry-bar pairs (j, j + 1) with j < k that are not one interval apart.
  const brokenBefore = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const broken = k + 1 < n && entryBars[k + 1].timestamp - entryBars[k].timestamp !== entryIntervalMs;
    brokenBefore[k + 1] = brokenBefore[k] + (broken ? 1 : 0);
  }
  const pathCandlesNeeded = maxHoldMs / PATH_INTERVAL_MS;
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
    let seen = 0;
    let needed = pathCandlesNeeded;
    for (let k = pathFrom; k < pathBars.length && pathBars[k].timestamp < windowEnd; k++) {
      const c = pathBars[k];
      seen++;
      const hitUp = c.high >= upper;
      const hitDown = c.low <= lower;
      if (!hitUp && !hitDown) continue;
      code = hitUp && hitDown ? OUTCOME_AMBIGUOUS : hitUp ? OUTCOME_UP : OUTCOME_DOWN;
      exit = c.timestamp + PATH_INTERVAL_MS;
      needed = (c.timestamp - entryTime) / PATH_INTERVAL_MS + 1;
      break;
    }
    outcome[t] = code;
    exitMs[t] = exit;
    entryMs[t] = entryTime;
    atrPct[t] = (a / entryBars[t - 1].close) * 100;
    entryPrice[t] = entry;
    atrAbs[t] = a;
    const atrWindowBroken = brokenBefore[t] - brokenBefore[Math.max(0, t - atrPeriod)] > 0;
    gap[t] = atrWindowBroken || seen < needed ? 1 : 0;
  }
  return { outcome, exitMs, entryMs, atrPct, entryPrice, atrAbs, gap };
}
