/**
 * Round 3 (lab-v4) pre-lock preview script for C1 and C2.
 * Computes descriptive preview on history to set scale c and estimate power/null crossing rates.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { barDelta, deltaDivergences, DIVERGENCE_MAX_BARS } from '../../src/lib/market/delta';
import { analyzeStructure, findPivots, SWING_LENGTH } from '../../src/lib/market/structure';
import { initialEState, stepEProcess, type EProcessState } from '../../src/lib/signals/lab/e-process';
import { SIGNAL_SYMBOLS } from '../../src/lib/signals/signal-symbols';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';
import type { OHLCV } from '../../src/types/market';
import { loadFunding, loadManifest, loadPerp, verifyManifest } from './load-dataset';
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
}

export interface PowerSimResult {
  measured: PowerCaseResult;
  plus05bps: PowerCaseResult;
  plus10bps: PowerCaseResult;
  plus20bps: PowerCaseResult;
  [key: string]: PowerCaseResult;
}

export interface NullSimOptions {
  seed?: number;
  runsCount?: number;
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
 * Evaluates e-process crossing log(800) at measured mean and shifted mean trade nets.
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
          { threshold: 800, lossUnbounded: true }
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
    '+0.05%': plus05bps,
    '+0.10%': plus10bps,
    '+0.20%': plus20bps,
  };
}

/**
 * 300 runs where each trade's side is flipped with probability 0.5 before rebuilding R_t,
 * giving the crossing share under the null hypothesis.
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
        { threshold: 800, lossUnbounded: true }
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

export async function runPreview(args: CliArgs): Promise<void> {
  const verifyResult = await verifyManifest(args.datasetDir);
  if (!verifyResult.ok) {
    throw new Error(`Manifest verification failed: ${verifyResult.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  const datasetHash = manifest.datasetHash;

  const fromMs = parseBound(args.from, true);
  const toMs = parseBound(args.to, false);

  const c1TradesBySymbol: Record<string, Trade[]> = {};
  const c2TradesBySymbol: Record<string, Trade[]> = {};
  let c1GapSkips = 0;
  let c2GapSkips = 0;

  for (const symbol of SIGNAL_SYMBOLS) {
    const perpResult = loadPerp(args.datasetDir, symbol, '1h', 'klines');
    const fundingResult = loadFunding(args.datasetDir, symbol);

    const bars: OHLCV[] = perpResult.rows
      .filter((row) => row.t >= fromMs && row.t <= toMs)
      .map((row) => ({
        timestamp: row.t,
        open: row.o,
        high: row.h,
        low: row.l,
        close: row.c,
        volume: row.v,
        takerBuyVolume: row.tbv ?? undefined,
      }));

    const settlements = fundingResult.rows;

    const c1Sigs = c1Signals(bars);
    c1TradesBySymbol[symbol] = tradesFor(bars, settlements, c1Sigs);
    c1GapSkips += countGapSkips(bars, c1Sigs);

    const c2Sigs = c2Signals(bars);
    c2TradesBySymbol[symbol] = tradesFor(bars, settlements, c2Sigs);
    c2GapSkips += countGapSkips(bars, c2Sigs);
  }

  // C1
  const c1Series = betSeries(c1TradesBySymbol);
  const c1AllTrades = Object.values(c1TradesBySymbol).flat();
  const c1Stats = stats(c1Series, c1AllTrades);
  const c1BetBarsPerYear = c1Stats.yearsSpanned > 0 ? c1Series.length / c1Stats.yearsSpanned : 0;
  const c1Power = powerSim(c1Series, c1Stats.scale, c1BetBarsPerYear, {
    trades: c1AllTrades,
    tradesCount: c1AllTrades.length,
  });
  const c1Null = nullSim(c1AllTrades, c1Stats.scale);

  // C2
  const c2Series = betSeries(c2TradesBySymbol);
  const c2AllTrades = Object.values(c2TradesBySymbol).flat();
  const c2Stats = stats(c2Series, c2AllTrades);
  const c2BetBarsPerYear = c2Stats.yearsSpanned > 0 ? c2Series.length / c2Stats.yearsSpanned : 0;
  const c2Power = powerSim(c2Series, c2Stats.scale, c2BetBarsPerYear, {
    trades: c2AllTrades,
    tradesCount: c2AllTrades.length,
  });
  const c2Null = nullSim(c2AllTrades, c2Stats.scale);

  const output = {
    datasetHash,
    from: args.from,
    to: args.to,
    candidates: {
      C1: {
        scale: c1Stats.scale,
        gapSkips: c1GapSkips,
        stats: c1Stats,
        power: c1Power,
        null: c1Null,
      },
      C2: {
        scale: c2Stats.scale,
        gapSkips: c2GapSkips,
        stats: c2Stats,
        power: c2Power,
        null: c2Null,
      },
    },
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(output, null, 2), 'utf8');

  console.log(`Preview written to ${args.out}`);
  console.log(`C1: ${c1AllTrades.length} trades, ${c1Series.length} bet bars, scale ${c1Stats.scale}, gap skips: ${c1GapSkips}`);
  console.log(`C1 mean net: ${(c1Stats.tradeMean * 100).toFixed(3)}%, t-stat: ${c1Stats.tradeTStat.toFixed(2)}`);
  console.log(`C2: ${c2AllTrades.length} trades, ${c2Series.length} bet bars, scale ${c2Stats.scale}, gap skips: ${c2GapSkips}`);
  console.log(`C2 mean net: ${(c2Stats.tradeMean * 100).toFixed(3)}%, t-stat: ${c2Stats.tradeTStat.toFixed(2)}`);
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
