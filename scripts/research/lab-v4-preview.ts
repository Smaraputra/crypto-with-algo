/**
 * Round 3 (lab-v4) pre-lock preview for C1, C2 and C7.
 *
 * PRE-RUN DECLARATION (committed before any run of this script on data; owner decisions 2026-10-22)
 * - Cells, each one a ledger trial (3 in all): one rule per candidate, one management spec, the 10 signal symbols,
 *   USDT-M perp 1h klines with taker-buy volume, funding settlements and the 5-minute metrics grid, window 2022-01-01 to
 *   2026-06-30. The lockbox from 2026-07-01 is never read.
 *   - C1: a 1h swing CHoCH (swing length 20, close-break) whose break bar's delta has the same sign. Trade with the break.
 *   - C2: a regular delta divergence between the two most recent confirmed swing pivots of one type, at most 72 bars
 *     apart. Fade it.
 *   - C7: open interest with funding crowding, judged at each funding settlement T. Short when the settled rate is above
 *     0.0001 (Binance's interest component per 8h, venue-given) and open interest read at T - 5 min exceeds open interest
 *     read 24 h earlier (the 24 h lookback is our choice). Long when the settled rate is below 0 and open interest is
 *     rising the same way. Source: session 19 rows C7 and X2 (negative funding with rising open interest marks a short
 *     squeeze, funding spikes mark crowding).
 * - Management, the same for all three: the signal bar is a closed 1h bar, entry at the next 1h open, exit at the open
 *   8 bars later, one trade per coin at a time, 14 bps round trip, and funding settled in (entry, exit] charged by side.
 * - C1 is a variant of the failed bos-continuation family (2-bar fractal breaks at 15m, 1h and 4h). The owner kept it on
 *   2026-10-22. C3, also a break-of-structure variant, is not previewed.
 * - Any earlier run of the C1/C2 preview by the session focus-chart-round-3, once known, adds its cells to the ledger.
 * - Decision table, applied mechanically to this run's output:
 *   - A candidate's figure at a threshold is the smaller of its iid and block bootstrap crossing shares within 24 months,
 *     with its R series shifted to HALF its preview mean R (against the winner's curse). A non-positive preview mean R
 *     fails at every threshold.
 *   - Two slots at threshold 800, only if two candidates each reach 0.20 at threshold 800. The two highest figures at 800
 *     take them.
 *   - Otherwise one slot at threshold 400, for the candidate with the highest figure at 400 if it reaches 0.20.
 *   - Otherwise nothing is registered.
 *   - Ties go to the higher preview trade t-statistic. Unspent alpha is never reallocated without a new pre-stated rule.
 *   - A rerun, or any change to a candidate or to this declaration after the first run, adds new ledger trials.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { barDelta, deltaDivergences, DIVERGENCE_MAX_BARS } from '../../src/lib/market/delta';
import { analyzeStructure, findPivots, SWING_LENGTH } from '../../src/lib/market/structure';
import { initialEState, stepEProcess, type EProcessState } from '../../src/lib/signals/lab/e-process';
import { SIGNAL_SYMBOLS } from '../../src/lib/signals/signal-symbols';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';
import type { OHLCV } from '../../src/types/market';
import type { MetricsRow } from './dataset-format';
import { loadFunding, loadManifest, loadMetrics, loadPerp, verifyManifest } from './load-dataset';
import { roundUp2SigFigs } from './nv2-preview';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const YEAR_MS = 365.25 * DAY_MS;
/**
 * Round-trip cost per trade: 7 bps a side taker (5 bps fee plus 2 bps slippage), twice.
 */
export const ROUND_TRIP_COST = 0.0014;

export interface Signal {
  index: number;
  side: number;
}

export interface Trade {
  entryTime: number;
  exitTime: number;
  side: number;
  r: number;
  funding: number;
  net: number;
}

export interface BetSeriesItem {
  time: number;
  R: number;
}

export interface YearStats {
  trades: number;
  meanNet: number;
  meanTradeNet: number;
  sumNet: number;
}

export interface StatsResult {
  trades: number;
  betBars: number;
  yearsSpanned: number;
  tradeMean: number;
  tradeSd: number;
  tradeTStat: number;
  rMean: number;
  rSd: number;
  scale: number;
  shareBelowMinusC: number;
  shareBelowMinus2C: number;
  byYear: Record<string, YearStats>;
  meanTradeNet: number;
  sdTradeNet: number;
  tStat: number;
  meanR: number;
  sdR: number;
}

export interface PowerThresholdResult {
  share: number;
  medianBar: number | null;
}

export interface PowerCaseResult {
  iid: PowerThresholdResult;
  block: PowerThresholdResult;
}

export interface PowerSimOptions {
  seed?: number;
  runsCount?: number;
  tradesCount?: number;
  trades?: readonly Trade[];
  meanBlockLength?: number;
  threshold?: number;
}

export interface PowerSimResult {
  measured: PowerCaseResult;
  plus05bps: PowerCaseResult;
  plus10bps: PowerCaseResult;
  plus20bps: PowerCaseResult;
  halfMean: PowerCaseResult;
  sharpe2: PowerCaseResult;
  [key: string]: PowerCaseResult;
}

export interface NullSimOptions {
  seed?: number;
  runsCount?: number;
  threshold?: number;
}

export interface NullSimResult {
  share: number;
  crossingShare: number;
  crossingCount: number;
  maxLogE: number;
}

/**
 * C1, structure reversal with flow:
 * Events from analyzeStructure(bars, 20) with type === 'CHoCH' whose break bar's barDelta
 * has the same sign as the event direction (bull needs delta > 0, bear needs delta < 0; zero or null delta means no signal).
 * The signal bar is breakIndex. Side is +1 for bull, -1 for bear.
 */
export function c1Signals(bars: readonly OHLCV[]): Signal[] {
  const structure = analyzeStructure(bars, SWING_LENGTH);
  const signals: Signal[] = [];

  for (const event of structure.events) {
    if (event.type !== 'CHoCH') continue;
    const breakBar = bars[event.breakIndex];
    if (!breakBar) continue;

    const delta = barDelta(breakBar);
    if (delta === null || delta === 0) continue;

    if (event.direction === 'bull' && delta > 0) {
      signals.push({ index: event.breakIndex, side: 1 });
    } else if (event.direction === 'bear' && delta < 0) {
      signals.push({ index: event.breakIndex, side: -1 });
    }
  }

  return signals;
}

/**
 * C2, flow divergence at swing pivots (fade):
 * deltaDivergences(bars, findPivots(bars, 20), 72) filtered to kind === 'regular'.
 * The signal bar is confirmedIndex. Side is -1 for a regular bear, +1 for a regular bull.
 */
export function c2Signals(bars: readonly OHLCV[]): Signal[] {
  const pivots = findPivots(bars, SWING_LENGTH);
  const divergences = deltaDivergences(bars, pivots, DIVERGENCE_MAX_BARS);
  const signals: Signal[] = [];

  for (const div of divergences) {
    if (div.kind !== 'regular') continue;
    const side = div.direction === 'bear' ? -1 : 1;
    signals.push({ index: div.confirmedIndex, side });
  }

  return signals;
}

/** Binance's interest component per 8h settlement. Funding above it means longs pay a premium. Venue-given. */
export const C7_FUNDING_BASELINE = 0.0001;
/** Open interest is compared with its value this long before. Our choice: one day, three 8h settlements. */
export const C7_OI_LOOKBACK_MS = 24 * HOUR_MS;
/** Open interest is read from metrics rows at or before T - 5 min, never later (publication lag). */
export const C7_OI_LAG_MS = 5 * 60_000;
/** A metrics row older than this before its read time is treated as missing. */
export const C7_OI_MAX_STALENESS_MS = 15 * 60_000;

/**
 * C7, open interest with funding crowding:
 * Evaluated at each funding settlement T. Short (-1) when settled rate > 0.0001 and open interest is rising over 24h.
 * Long (+1) when settled rate < 0 and open interest is rising over 24h.
 */
export function c7Signals(
  bars: readonly OHLCV[],
  settlements: readonly { t: number; rate: number }[],
  metrics: readonly MetricsRow[]
): Signal[] {
  const barIndexByTimestamp = new Map<number, number>();
  for (let i = 0; i < bars.length; i++) {
    barIndexByTimestamp.set(bars[i].timestamp, i);
  }
  const sortedMetrics = [...metrics].sort((a, b) => a.t - b.t);

  const oiAt = (readTime: number): number | null => {
    let low = 0;
    let high = sortedMetrics.length - 1;
    let lastIdx = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (sortedMetrics[mid].t <= readTime) {
        lastIdx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (lastIdx === -1) return null;
    const row = sortedMetrics[lastIdx];
    if (row.t < readTime - C7_OI_MAX_STALENESS_MS) return null;
    const oi = row.openInterest;
    if (typeof oi !== 'number' || !Number.isFinite(oi) || oi <= 0) return null;
    return oi;
  };

  const signals: Signal[] = [];
  for (const s of settlements) {
    const T = Math.round(s.t / HOUR_MS) * HOUR_MS;
    const barIndex = barIndexByTimestamp.get(T - HOUR_MS);
    if (barIndex === undefined) {
      continue;
    }

    const oiNow = oiAt(T - C7_OI_LAG_MS);
    const oiPrev = oiAt(T - C7_OI_LOOKBACK_MS - C7_OI_LAG_MS);
    if (oiNow === null || oiPrev === null || oiNow <= oiPrev) {
      continue;
    }

    if (s.rate > C7_FUNDING_BASELINE) {
      signals.push({ index: barIndex, side: -1 });
    } else if (s.rate < 0) {
      signals.push({ index: barIndex, side: 1 });
    }
  }

  signals.sort((a, b) => a.index - b.index);
  return signals;
}

/**
 * Trade execution with the overlap rule:
 * A trade from a signal at bar s enters at the open of bar s + 1 and exits at the open of bar s + 9 (8 bars held).
 * Skip it when either bar is missing or when timestamps have a gap.
 * - Price return r = exit / entry - 1.
 * - Funding F = sum of settlement rates with time in (entry bar open time, exit bar open time].
 * - Trade return = side * r - side * F - 0.0014.
 * - Overlap: per symbol and candidate, a signal whose entry bar is before the current trade's exit bar is ignored.
 */
export function tradesFor(
  bars: readonly OHLCV[],
  settlements: readonly { t: number; rate: number }[],
  signals: readonly Signal[]
): Trade[] {
  const trades: Trade[] = [];
  let currentExitIndex = -1;

  const sortedSignals = [...signals].sort((a, b) => a.index - b.index);

  for (const sig of sortedSignals) {
    const entryIndex = sig.index + 1;
    const exitIndex = sig.index + 9;

    if (sig.index < 0 || entryIndex >= bars.length || exitIndex >= bars.length) {
      continue;
    }
    const signalBar = bars[sig.index];
    const entryBar = bars[entryIndex];
    const exitBar = bars[exitIndex];
    if (!signalBar || !entryBar || !exitBar) {
      continue;
    }

    if (currentExitIndex !== -1 && entryIndex < currentExitIndex) {
      continue;
    }

    if (
      entryBar.timestamp !== signalBar.timestamp + HOUR_MS ||
      exitBar.timestamp !== entryBar.timestamp + 8 * HOUR_MS
    ) {
      continue;
    }

    const entryPrice = entryBar.open;
    const exitPrice = exitBar.open;
    if (entryPrice <= 0 || !Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) {
      continue;
    }

    const entryTime = entryBar.timestamp;
    const exitTime = exitBar.timestamp;
    const r = exitPrice / entryPrice - 1;

    let funding = 0;
    for (let i = 0; i < settlements.length; i++) {
      const s = settlements[i];
      if (s.t > entryTime && s.t <= exitTime) {
        funding += s.rate;
      }
    }

    const net = sig.side * r - sig.side * funding - ROUND_TRIP_COST;

    trades.push({
      entryTime,
      exitTime,
      side: sig.side,
      r,
      funding,
      net,
    });

    currentExitIndex = exitIndex;
  }

  return trades;
}

/**
 * Counts how many signals were skipped because of gaps between signal and entry,
 * or inside the 8-hour hold. Signals ignored under the overlap rule are not counted as gap skips.
 */
export function countGapSkips(
  bars: readonly OHLCV[],
  signals: readonly Signal[]
): number {
  let count = 0;
  let currentExitIndex = -1;

  const sortedSignals = [...signals].sort((a, b) => a.index - b.index);

  for (const sig of sortedSignals) {
    const entryIndex = sig.index + 1;
    const exitIndex = sig.index + 9;

    if (sig.index < 0 || entryIndex >= bars.length || exitIndex >= bars.length) {
      continue;
    }
    const signalBar = bars[sig.index];
    const entryBar = bars[entryIndex];
    const exitBar = bars[exitIndex];
    if (!signalBar || !entryBar || !exitBar) {
      continue;
    }

    if (currentExitIndex !== -1 && entryIndex < currentExitIndex) {
      continue;
    }

    if (
      entryBar.timestamp !== signalBar.timestamp + HOUR_MS ||
      exitBar.timestamp !== entryBar.timestamp + 8 * HOUR_MS
    ) {
      count++;
      continue;
    }

    const entryPrice = entryBar.open;
    const exitPrice = exitBar.open;
    if (entryPrice <= 0 || !Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) {
      continue;
    }

    currentExitIndex = exitIndex;
  }

  return count;
}

/**
 * Lab statistic per signal bar:
 * For each entry-bar open time, R_t = sum of trade returns entering at that time across symbols.
 * Times with no entry place no bet and are not in the series.
 */
export function betSeries(
  tradesBySymbol:
    | Record<string, readonly Trade[]>
    | Map<string, readonly Trade[]>
    | readonly (readonly Trade[])[]
): BetSeriesItem[] {
  const tradeLists: readonly (readonly Trade[])[] =
    tradesBySymbol instanceof Map
      ? Array.from(tradesBySymbol.values())
      : Array.isArray(tradesBySymbol)
      ? tradesBySymbol
      : Object.values(tradesBySymbol);

  const rByTime = new Map<number, number>();

  for (let l = 0; l < tradeLists.length; l++) {
    const list = tradeLists[l];
    for (let i = 0; i < list.length; i++) {
      const tr = list[i];
      const existing = rByTime.get(tr.entryTime) ?? 0;
      rByTime.set(tr.entryTime, existing + tr.net);
    }
  }

  const series: BetSeriesItem[] = [];
  for (const [time, R] of rByTime.entries()) {
    series.push({ time, R });
  }

  series.sort((a, b) => a.time - b.time);
  return series;
}

/**
 * Computes descriptive statistics over trades and R_t bet series.
 */
export function stats(
  series: readonly BetSeriesItem[],
  trades: readonly Trade[]
): StatsResult {
  const numTrades = trades.length;
  const numBetBars = series.length;

  let yearsSpanned = 0;
  if (series.length > 1) {
    const spanMs = series[series.length - 1].time - series[0].time;
    yearsSpanned = spanMs / YEAR_MS;
  }

  let tradeMean = 0;
  let tradeSd = 0;
  let tradeTStat = 0;
  if (numTrades > 0) {
    let sumNet = 0;
    for (let i = 0; i < numTrades; i++) {
      sumNet += trades[i].net;
    }
    tradeMean = sumNet / numTrades;

    if (numTrades > 1) {
      let sumSq = 0;
      for (let i = 0; i < numTrades; i++) {
        const d = trades[i].net - tradeMean;
        sumSq += d * d;
      }
      tradeSd = Math.sqrt(sumSq / (numTrades - 1));
      if (tradeSd > 0) {
        tradeTStat = tradeMean / (tradeSd / Math.sqrt(numTrades));
      }
    }
  }

  let rMean = 0;
  let rSd = 0;
  if (numBetBars > 0) {
    let sumR = 0;
    for (let i = 0; i < numBetBars; i++) {
      sumR += series[i].R;
    }
    rMean = sumR / numBetBars;

    if (numBetBars > 1) {
      let sumSq = 0;
      for (let i = 0; i < numBetBars; i++) {
        const d = series[i].R - rMean;
        sumSq += d * d;
      }
      rSd = Math.sqrt(sumSq / (numBetBars - 1));
    }
  }

  const scale = roundUp2SigFigs(4 * rSd);

  let belowC = 0;
  let below2C = 0;
  if (numBetBars > 0 && scale > 0) {
    for (let i = 0; i < numBetBars; i++) {
      if (series[i].R < -scale) belowC++;
      if (series[i].R < -2 * scale) below2C++;
    }
  }
  const shareBelowMinusC = numBetBars > 0 ? belowC / numBetBars : 0;
  const shareBelowMinus2C = numBetBars > 0 ? below2C / numBetBars : 0;

  const tradesByYear = new Map<string, Trade[]>();
  for (let i = 0; i < numTrades; i++) {
    const tr = trades[i];
    const yr = String(new Date(tr.entryTime).getUTCFullYear());
    if (!tradesByYear.has(yr)) tradesByYear.set(yr, []);
    tradesByYear.get(yr)!.push(tr);
  }

  const byYear: Record<string, YearStats> = {};
  for (const [yr, yrTrades] of tradesByYear.entries()) {
    let sum = 0;
    for (let i = 0; i < yrTrades.length; i++) {
      sum += yrTrades[i].net;
    }
    const mean = yrTrades.length > 0 ? sum / yrTrades.length : 0;
    byYear[yr] = {
      trades: yrTrades.length,
      meanNet: mean,
      meanTradeNet: mean,
      sumNet: sum,
    };
  }

  return {
    trades: numTrades,
    betBars: numBetBars,
    yearsSpanned,
    tradeMean,
    tradeSd,
    tradeTStat,
    rMean,
    rSd,
    scale,
    shareBelowMinusC,
    shareBelowMinus2C,
    byYear,
    meanTradeNet: tradeMean,
    sdTradeNet: tradeSd,
    tStat: tradeTStat,
    meanR: rMean,
    sdR: rSd,
  };
}

export function medianOf(arr: number[]): number | null {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 300 runs each of iid and stationary block bootstrap (mean block 10),
 * with round(betBarsPerYear * 2) bars per run (24 months).
 * Evaluates e-process crossing log(threshold) (default 800) at measured mean and shifted mean trade nets.
 */
export function powerSim(
  series: readonly (BetSeriesItem | number)[],
  scale: number,
  betBarsPerYear: number,
  opts: PowerSimOptions = {}
): PowerSimResult {
  const rValues: number[] = series.map((s) => (typeof s === 'number' ? s : s.R));
  const n = rValues.length;
  const barsCount = Math.max(1, Math.round(betBarsPerYear * 2));
  const runsCount = opts.runsCount ?? 300;
  const baseSeed = opts.seed ?? 42;
  const meanBlockLength = opts.meanBlockLength ?? 10;
  const pBlock = 1 / meanBlockLength;
  const threshold = opts.threshold ?? 800;

  if (n === 0 || scale <= 0) {
    const emptyResult: PowerCaseResult = {
      iid: { share: 0, medianBar: null },
      block: { share: 0, medianBar: null },
    };
    return {
      measured: emptyResult,
      plus05bps: emptyResult,
      plus10bps: emptyResult,
      plus20bps: emptyResult,
      halfMean: emptyResult,
      sharpe2: emptyResult,
      '+0.05%': emptyResult,
      '+0.10%': emptyResult,
      '+0.20%': emptyResult,
    };
  }

  const measuredMeanR = rValues.reduce((acc, v) => acc + v, 0) / n;
  const numTrades = opts.tradesCount ?? (opts.trades ? opts.trades.length : n);
  const kTradesPerBar = numTrades / n;

  const runSimulationForR = (rSeries: readonly number[]): PowerCaseResult => {
    const rng = createSeededRandom(baseSeed);

    const evalRun = (sampled: readonly number[]): number | null => {
      let state: EProcessState = initialEState();
      for (let bar = 1; bar <= barsCount; bar++) {
        const r = sampled[bar - 1];
        const x = Math.min(r / scale, 1);
        const step = stepEProcess(
          state,
          { barTime: bar, x, b: 0 },
          { threshold, lossUnbounded: true }
        );
        state = step.state;
        if (state.crossedAt !== null) {
          return state.crossedAt;
        }
      }
      return null;
    };

    const iidCrossings: number[] = [];
    for (let r = 0; r < runsCount; r++) {
      const sampled = new Array<number>(barsCount);
      for (let b = 0; b < barsCount; b++) {
        const idx = Math.floor(rng() * n);
        sampled[b] = rSeries[idx];
      }
      const res = evalRun(sampled);
      if (res !== null) {
        iidCrossings.push(res);
      }
    }

    const blockCrossings: number[] = [];
    for (let r = 0; r < runsCount; r++) {
      const sampled = new Array<number>(barsCount);
      let idx = Math.floor(rng() * n);
      for (let b = 0; b < barsCount; b++) {
        if (b > 0) {
          if (rng() < pBlock) {
            idx = Math.floor(rng() * n);
          } else {
            idx = (idx + 1) % n;
          }
        }
        sampled[b] = rSeries[idx];
      }
      const res = evalRun(sampled);
      if (res !== null) {
        blockCrossings.push(res);
      }
    }

    return {
      iid: {
        share: iidCrossings.length / runsCount,
        medianBar: medianOf(iidCrossings),
      },
      block: {
        share: blockCrossings.length / runsCount,
        medianBar: medianOf(blockCrossings),
      },
    };
  };

  const measured = runSimulationForR(rValues);

  const zeroPowerCase: PowerCaseResult = {
    iid: { share: 0, medianBar: null },
    block: { share: 0, medianBar: null },
  };

  const halfMean =
    measuredMeanR <= 0
      ? zeroPowerCase
      : runSimulationForR(rValues.map((v) => v + (0.5 * measuredMeanR - measuredMeanR)));

  let sdR = 0;
  if (n > 1) {
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const d = rValues[i] - measuredMeanR;
      sumSq += d * d;
    }
    sdR = Math.sqrt(sumSq / (n - 1));
  }

  const sharpe2 =
    sdR === 0 || betBarsPerYear <= 0
      ? zeroPowerCase
      : runSimulationForR(
          rValues.map((v) => v + ((2 * sdR) / Math.sqrt(betBarsPerYear) - measuredMeanR))
        );

  const shiftSeries = (targetTradeNet: number): number[] => {
    const targetMeanR = kTradesPerBar * targetTradeNet;
    const shift = targetMeanR - measuredMeanR;
    return rValues.map((v) => v + shift);
  };

  const plus05bps = runSimulationForR(shiftSeries(0.0005));
  const plus10bps = runSimulationForR(shiftSeries(0.0010));
  const plus20bps = runSimulationForR(shiftSeries(0.0020));

  return {
    measured,
    plus05bps,
    plus10bps,
    plus20bps,
    halfMean,
    sharpe2,
    '+0.05%': plus05bps,
    '+0.10%': plus10bps,
    '+0.20%': plus20bps,
  };
}

/**
 * 300 runs where each trade's side is flipped with probability 0.5 before rebuilding R_t,
 * giving the crossing share under the null hypothesis (default threshold 800).
 */
export function nullSim(
  tradesInput:
    | readonly Trade[]
    | Record<string, readonly Trade[]>
    | Map<string, readonly Trade[]>,
  scale: number,
  opts: NullSimOptions = {}
): NullSimResult {
  const tradeList: readonly Trade[] =
    tradesInput instanceof Map
      ? Array.from(tradesInput.values()).flat()
      : Array.isArray(tradesInput)
      ? tradesInput
      : Object.values(tradesInput).flat();

  const runsCount = opts.runsCount ?? 300;
  const seed = opts.seed ?? 42;
  const rng = createSeededRandom(seed);
  const threshold = opts.threshold ?? 800;

  if (tradeList.length === 0 || scale <= 0) {
    return {
      share: 0,
      crossingShare: 0,
      crossingCount: 0,
      maxLogE: 0,
    };
  }

  let crossingCount = 0;
  let maxLogE = -Infinity;

  for (let run = 0; run < runsCount; run++) {
    const rByTime = new Map<number, number>();

    for (let i = 0; i < tradeList.length; i++) {
      const tr = tradeList[i];
      const flip = rng() < 0.5;
      const nullSide = flip ? -tr.side : tr.side;
      const nullNet = nullSide * tr.r - nullSide * tr.funding - ROUND_TRIP_COST;

      const existing = rByTime.get(tr.entryTime) ?? 0;
      rByTime.set(tr.entryTime, existing + nullNet);
    }

    const times = Array.from(rByTime.keys()).sort((a, b) => a - b);

    let state = initialEState();
    let crossed = false;
    for (let bar = 1; bar <= times.length; bar++) {
      const r = rByTime.get(times[bar - 1])!;
      const x = Math.min(r / scale, 1);
      const step = stepEProcess(
        state,
        { barTime: bar, x, b: 0 },
        { threshold, lossUnbounded: true }
      );
      state = step.state;
      if (state.logE > maxLogE) {
        maxLogE = state.logE;
      }
      if (state.crossedAt !== null) {
        crossed = true;
        break;
      }
    }

    if (crossed) {
      crossingCount++;
    }
  }

  const share = runsCount > 0 ? crossingCount / runsCount : 0;
  return {
    share,
    crossingShare: share,
    crossingCount,
    maxLogE,
  };
}

export interface CliArgs {
  datasetDir: string;
  out: string;
  from: string;
  to: string;
}

export function parseCliArgs(args: string[]): CliArgs {
  let datasetDir = '';
  let out = '';
  let from = '2022-01-01';
  let to = '2026-06-30';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dataset-dir' && i + 1 < args.length) {
      datasetDir = args[++i];
    } else if (arg.startsWith('--dataset-dir=')) {
      datasetDir = arg.slice('--dataset-dir='.length);
    } else if (arg === '--out' && i + 1 < args.length) {
      out = args[++i];
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--from' && i + 1 < args.length) {
      from = args[++i];
    } else if (arg.startsWith('--from=')) {
      from = arg.slice('--from='.length);
    } else if (arg === '--to' && i + 1 < args.length) {
      to = args[++i];
    } else if (arg.startsWith('--to=')) {
      to = arg.slice('--to='.length);
    }
  }

  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');

  return { datasetDir, out, from, to };
}

export function parseBound(dateStr: string, isStart: boolean): number {
  if (dateStr.includes('T')) {
    return Date.parse(dateStr);
  }
  const suffix = isStart ? 'T00:00:00.000Z' : 'T23:59:59.999Z';
  return Date.parse(`${dateStr}${suffix}`);
}

export interface CandidateDecisionInput {
  id: string;
  meanR: number;
  tradeTStat: number;
  /** min(iid, block) halfMean share at threshold 400 and at threshold 800. */
  figure400: number;
  figure800: number;
}

export interface SlotDecision {
  slots: { id: string; threshold: 400 | 800 }[];
  reason: string;
}

export const DECISION_FLOOR = 0.2;

export function figureOf(power: PowerSimResult): number {
  return Math.min(power.halfMean.iid.share, power.halfMean.block.share);
}

export function decideSlots(candidates: readonly CandidateDecisionInput[]): SlotDecision {
  const eligible = candidates.filter((c) => c.meanR > 0);

  const sorted800 = [...eligible].sort((a, b) => {
    if (b.figure800 !== a.figure800) {
      return b.figure800 - a.figure800;
    }
    return b.tradeTStat - a.tradeTStat;
  });

  if (
    sorted800.length >= 2 &&
    sorted800[0].figure800 >= DECISION_FLOOR &&
    sorted800[1].figure800 >= DECISION_FLOOR
  ) {
    return {
      slots: [
        { id: sorted800[0].id, threshold: 800 },
        { id: sorted800[1].id, threshold: 800 },
      ],
      reason: 'two slots at 800',
    };
  }

  const sorted400 = [...eligible].sort((a, b) => {
    if (b.figure400 !== a.figure400) {
      return b.figure400 - a.figure400;
    }
    return b.tradeTStat - a.tradeTStat;
  });

  if (sorted400.length >= 1 && sorted400[0].figure400 >= DECISION_FLOOR) {
    return {
      slots: [{ id: sorted400[0].id, threshold: 400 }],
      reason: 'one slot at 400',
    };
  }

  return { slots: [], reason: 'nothing registered' };
}

export interface SymbolData {
  bars: readonly OHLCV[];
  settlements: readonly { t: number; rate: number }[];
  metrics: readonly MetricsRow[];
}

export interface CandidateSpec {
  id: 'C1' | 'C2' | 'C7';
  signals: (data: SymbolData) => Signal[];
}

export const CANDIDATES: readonly CandidateSpec[] = [
  { id: 'C1', signals: (d) => c1Signals(d.bars) },
  { id: 'C2', signals: (d) => c2Signals(d.bars) },
  { id: 'C7', signals: (d) => c7Signals(d.bars, d.settlements, d.metrics) },
];

export interface CandidatePreviewResult {
  scale: number;
  gapSkips: number;
  stats: StatsResult;
  trades: readonly Trade[];
  power: {
    t400: PowerSimResult;
    t800: PowerSimResult;
  };
  null: {
    t400: NullSimResult;
    t800: NullSimResult;
  };
  figure400: number;
  figure800: number;
}

export interface PreviewCandidatesResult {
  candidates: Record<string, CandidatePreviewResult>;
  decision: SlotDecision;
}

export function previewCandidates(
  dataBySymbol: Record<string, SymbolData>,
  fromMs: number,
  toMs: number,
  candidates: readonly CandidateSpec[] = CANDIDATES,
  simOpts: { runsCount?: number; seed?: number } = {}
): PreviewCandidatesResult {
  const filteredDataBySymbol: Record<string, SymbolData> = {};
  for (const [symbol, data] of Object.entries(dataBySymbol)) {
    filteredDataBySymbol[symbol] = {
      bars: data.bars.filter((b) => b.timestamp >= fromMs && b.timestamp <= toMs),
      settlements: data.settlements.filter((s) => s.t >= fromMs && s.t <= toMs),
      metrics: data.metrics.filter((m) => m.t >= fromMs && m.t <= toMs),
    };
  }

  const candidateResults: Record<string, CandidatePreviewResult> = {};

  for (const cand of candidates) {
    const tradesBySymbol: Record<string, Trade[]> = {};
    let gapSkips = 0;

    for (const [symbol, data] of Object.entries(filteredDataBySymbol)) {
      const sigs = cand.signals(data);
      tradesBySymbol[symbol] = tradesFor(data.bars, data.settlements, sigs);
      gapSkips += countGapSkips(data.bars, sigs);
    }

    const series = betSeries(tradesBySymbol);
    const allTrades = Object.values(tradesBySymbol).flat();
    const candidateStats = stats(series, allTrades);
    const betBarsPerYear =
      candidateStats.yearsSpanned > 0 ? series.length / candidateStats.yearsSpanned : 0;

    const power400 = powerSim(series, candidateStats.scale, betBarsPerYear, {
      ...simOpts,
      threshold: 400,
      trades: allTrades,
      tradesCount: allTrades.length,
    });
    const power800 = powerSim(series, candidateStats.scale, betBarsPerYear, {
      ...simOpts,
      threshold: 800,
      trades: allTrades,
      tradesCount: allTrades.length,
    });

    const null400 = nullSim(allTrades, candidateStats.scale, {
      ...simOpts,
      threshold: 400,
    });
    const null800 = nullSim(allTrades, candidateStats.scale, {
      ...simOpts,
      threshold: 800,
    });

    const figure400 = figureOf(power400);
    const figure800 = figureOf(power800);

    candidateResults[cand.id] = {
      scale: candidateStats.scale,
      gapSkips,
      stats: candidateStats,
      trades: allTrades,
      power: {
        t400: power400,
        t800: power800,
      },
      null: {
        t400: null400,
        t800: null800,
      },
      figure400,
      figure800,
    };
  }

  const decisionInputs: CandidateDecisionInput[] = candidates.map((c) => ({
    id: c.id,
    meanR: candidateResults[c.id].stats.meanR,
    tradeTStat: candidateResults[c.id].stats.tradeTStat,
    figure400: candidateResults[c.id].figure400,
    figure800: candidateResults[c.id].figure800,
  }));

  const decision = decideSlots(decisionInputs);

  return {
    candidates: candidateResults,
    decision,
  };
}

export async function runPreview(args: CliArgs): Promise<void> {
  const verifyResult = await verifyManifest(args.datasetDir);
  if (!verifyResult.ok) {
    throw new Error(`Manifest verification failed: ${verifyResult.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  const datasetHash = manifest.datasetHash;

  const fromMs = parseBound(args.from, true);
  const toMs = parseBound(args.to, false);

  const dataBySymbol: Record<string, SymbolData> = {};

  for (const symbol of SIGNAL_SYMBOLS) {
    const perpResult = loadPerp(args.datasetDir, symbol, '1h', 'klines');
    const fundingResult = loadFunding(args.datasetDir, symbol);
    const metricsResult = loadMetrics(args.datasetDir, symbol);

    const bars: OHLCV[] = perpResult.rows.map((row) => ({
      timestamp: row.t,
      open: row.o,
      high: row.h,
      low: row.l,
      close: row.c,
      volume: row.v,
      takerBuyVolume: row.tbv ?? undefined,
    }));

    dataBySymbol[symbol] = {
      bars,
      settlements: fundingResult.rows,
      metrics: metricsResult.rows,
    };
  }

  const result = previewCandidates(dataBySymbol, fromMs, toMs);

  const output = {
    datasetHash,
    from: args.from,
    to: args.to,
    ...result,
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(output, null, 2), 'utf8');

  console.log(`Preview written to ${args.out}`);
  for (const [id, c] of Object.entries(result.candidates)) {
    console.log(
      `${id}: ${c.stats.trades} trades, ${c.stats.betBars} bet bars, ` +
        `mean net: ${(c.stats.tradeMean * 100).toFixed(3)}%, t-stat: ${c.stats.tradeTStat.toFixed(2)}, ` +
        `scale: ${c.scale}, figure400: ${c.figure400.toFixed(3)}, figure800: ${c.figure800.toFixed(3)}`
    );
  }
  console.log(
    `Decision: ${result.decision.reason} (${
      result.decision.slots.map((s) => `${s.id}@${s.threshold}`).join(', ') || 'none'
    })`
  );
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseCliArgs(argv);
  runPreview(args)
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

const isDirectRun =
  (typeof require !== 'undefined' && require.main === module) ||
  (typeof process !== 'undefined' &&
    process.argv[1] &&
    process.argv[1].endsWith('lab-v4-preview.ts'));

if (isDirectRun) {
  main();
}
