/**
 * Pooled statistics and the eight fixed validation gates a strategy family
 * must clear across the ten study symbols, built on top of C4a's per-symbol
 * walk-forward output (strategy-walk-forward.ts). Pure, no I/O: every input
 * is a plain value the caller supplies (typically the strategy harness CLI).
 *
 * VALIDATION_PROTOCOL and the gate order/thresholds are fixed by the
 * research program's controller and must not be tuned by an implementer or
 * a research agent; see the C4b task brief for the reasoning behind each
 * number.
 *
 * Every statistic that can come out NaN or Infinity (a mean of zero trades,
 * a ratio with a zero denominator, a degenerate bootstrap or plateau
 * computation) is stored as null via the local toFinite helper below.
 * JSON.stringify silently turns NaN into null, so leaving these as raw
 * numbers would make a NaN indistinguishable from a real, freakishly small
 * value once the report round-trips through JSON; storing null makes "no
 * usable statistic here" explicit and machine-checkable (see
 * report-schema.ts's StrategyReportSchema, whose nullable fields mirror
 * this module's PooledStats/Gate shapes field for field).
 */

import {
  bootstrapCi,
  maxDrawdownPercentOfPnl,
  meanOf,
} from '@/lib/stats/block-bootstrap';
import {
  deflatedSharpe,
  perPeriodSharpe,
  psrRadicand,
} from '@/lib/stats/deflated-sharpe';
import { sampleKurtosis, sampleSkewness } from '@/lib/stats/normal';
import { parameterPlateauScore } from '@/lib/stats/plateau';
import type { OosTrade, StrategyWalkForwardResult } from './strategy-walk-forward';

export const VALIDATION_PROTOCOL = {
  minOosTrades: { default: 100, '5m': 300 },
  minWindowPositiveShare: 0.6,
  minSymbolPositiveShare: 0.7,
  maxRandomEntryP: 0.05,
  minDeflatedSharpeProbability: 0.95,
  minPlateauScore: 0.6,
  stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
  bootstrap: { iterations: 1000, alpha: 0.05 },
} as const;

/** 300 out-of-sample trades for 5m (its finer bars need a bigger sample to say
 * anything), 100 for every other interval. */
export function minOosTradesFor(interval: string): number {
  return interval === '5m' ? VALIDATION_PROTOCOL.minOosTrades['5m'] : VALIDATION_PROTOCOL.minOosTrades.default;
}

export type GateName =
  | 'sample'
  | 'expectancy'
  | 'windows'
  | 'symbols'
  | 'timing'
  | 'trials'
  | 'plateau'
  | 'stress';

export interface Gate {
  name: GateName;
  pass: boolean;
  value: number | null;
  threshold: number;
  note?: string;
}

export interface PooledStats {
  n: number;
  expectancyPercent: number | null;
  expectancyR: number | null;
  winRate: number | null;
  profitFactor: number | null;
  medianHoldBars: number | null;
  maxDrawdownPercent: number | null;
  bootstrapCi95: [number, number] | null;
  bootstrap: { iterations: number; seed: number; meanBlockLen: number };
  windowsTotal: number;
  windowsPositive: number;
  windowPositiveShare: number;
  symbolsTotal: number;
  symbolsPositive: number;
  symbolPositiveShare: number;
  benchmarkWindows: number;
  randomEntryP: number | null;
  trials: number;
  deflatedSharpe: {
    observedSharpe: number;
    benchmarkSharpe: number;
    probability: number | null;
    radicand: number;
    varianceOfTrialSharpes: number;
  } | null;
  plateau: {
    score: number | null;
    neighbors: number;
    bestMetric: number;
    bestParams: Record<string, number>;
    neighborRadius: number;
  } | null;
  stressTrades: number;
  stressExpectancyPercent: number | null;
  perYear: Array<{ year: number; trades: number; expectancyPercent: number }>;
}

/** Exported for strategy-harness.ts's report assembly, which needs the same
 * NaN/Infinity-to-null conversion for every float it writes into a report. */
export function toFinite(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

/** Like toFinite, but for fields the schema declares as plain (non-nullable)
 * numbers: falls back to `fallback` instead of null on a non-finite input.
 * Exported for the same reason as toFinite. */
export function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Sample variance (n-1 denominator), 0 for fewer than 2 values (matching
 * deflated-sharpe.ts's own convention that a single trial has no spread). */
function sampleVariance(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
}

function share(positive: number, total: number): number {
  return total === 0 ? 0 : positive / total;
}

/**
 * Every selected out-of-sample trade across every symbol and window, sorted
 * by exit time ascending; ties keep symbol order (the order of `perSymbol`)
 * then window order (each symbol's own `windows` order), which the stable
 * Array.prototype.sort preserves for equal keys since the trades are pushed
 * in exactly that symbol-major, window-minor order to begin with.
 */
function pooledTradesOf(perSymbol: StrategyWalkForwardResult[]): OosTrade[] {
  const trades: OosTrade[] = [];
  for (const s of perSymbol) {
    for (const w of s.windows) {
      trades.push(...w.oosTrades);
    }
  }
  return trades.sort((a, b) => a.exitTime - b.exitTime);
}

/**
 * One pooled pnlPercent array per grid cell index, gathered from every
 * window's oosCells entry at that index (every cell's out-of-sample run is
 * recorded for every window regardless of which cell was selected), across
 * every symbol. Index-aligned with the `cells` array the caller passed to
 * poolStrategyResults, which must be the same cells array (and order) every
 * window's oosCells was built against.
 */
function perCellPooledPnl(perSymbol: StrategyWalkForwardResult[], cellCount: number): number[][] {
  const perCell: number[][] = Array.from({ length: cellCount }, () => []);
  for (const s of perSymbol) {
    for (const w of s.windows) {
      w.oosCells.forEach((cell, i) => {
        if (i < cellCount) perCell[i].push(...cell.pnlPercents);
      });
    }
  }
  return perCell;
}

export interface PoolStrategyResultsOptions {
  interval: string;
  cells: Record<string, number>[];
  familyCount: number;
  trialsOverride?: number;
  bootstrapIterations: number;
  seed: number;
}

export function poolStrategyResults(
  perSymbol: StrategyWalkForwardResult[],
  opts: PoolStrategyResultsOptions
): PooledStats {
  const { cells, familyCount, trialsOverride, bootstrapIterations, seed } = opts;

  const trades = pooledTradesOf(perSymbol);
  const n = trades.length;
  const pnlPercents = trades.map((t) => t.pnlPercent);
  const pnls = trades.map((t) => t.pnl);

  const expectancyPercent = n === 0 ? null : toFinite(meanOf(pnlPercents));

  const riskAdjusted = trades
    .filter((t) => Number.isFinite(t.riskPercent) && t.riskPercent > 0)
    .map((t) => t.pnlPercent / t.riskPercent);
  const expectancyR = riskAdjusted.length === 0 ? null : toFinite(meanOf(riskAdjusted));

  const winCount = trades.filter((t) => t.pnl > 0).length;
  const winRate = toFinite(winCount / n);

  const positiveSum = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const negativeSumAbs = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = toFinite(positiveSum / negativeSumAbs);

  const medianHoldBars = toFinite(median(trades.map((t) => t.holdTimeBars)));
  // maxDrawdownPercentOfPnl([], 10000) returns 0 (a real, finite "no drawdown"
  // over an empty walk), which toFinite would not catch -- null it explicitly
  // for n === 0 so it fails null-vs-0 the same way every other pooled ratio
  // does when there is no data to compute it from.
  const maxDrawdownPercent = n === 0 ? null : toFinite(maxDrawdownPercentOfPnl(pnls, 10000));

  const meanBlockLen = Math.max(2, Math.round(Math.cbrt(n)));
  const bootstrap = { iterations: bootstrapIterations, seed, meanBlockLen };
  let bootstrapCi95: [number, number] | null = null;
  if (n >= 2) {
    const ci = bootstrapCi(pnlPercents, meanOf, { iterations: bootstrapIterations, meanBlockLen, seed });
    bootstrapCi95 = [ci.low, ci.high];
  }

  let windowsTotal = 0;
  let windowsPositive = 0;
  for (const s of perSymbol) {
    for (const w of s.windows) {
      windowsTotal++;
      if (w.oos !== null && w.oos.trades >= 1 && w.oos.expectancyPercent > 0) {
        windowsPositive++;
      }
    }
  }
  const windowPositiveShare = share(windowsPositive, windowsTotal);

  const symbolsTotal = perSymbol.length;
  let symbolsPositive = 0;
  for (const s of perSymbol) {
    const symbolTrades = s.windows.flatMap((w) => w.oosTrades);
    if (symbolTrades.length >= 1 && meanOf(symbolTrades.map((t) => t.pnlPercent)) > 0) {
      symbolsPositive++;
    }
  }
  const symbolPositiveShare = share(symbolsPositive, symbolsTotal);

  const benchmarkWindows: NonNullable<StrategyWalkForwardResult['windows'][number]['benchmark']>[] = [];
  for (const s of perSymbol) {
    for (const w of s.windows) {
      if (w.benchmark) benchmarkWindows.push(w.benchmark);
    }
  }
  let randomEntryP: number | null = null;
  if (benchmarkWindows.length > 0) {
    const K = Math.min(...benchmarkWindows.map((b) => b.iterations));
    const totalReferenceTrades = benchmarkWindows.reduce((s, b) => s + b.referenceTrades, 0);
    let countGE = 0;
    for (let k = 0; k < K; k++) {
      const weightedSum = benchmarkWindows.reduce(
        (s, b) => s + b.referenceTrades * b.randomExpectancies[k],
        0
      );
      const pooledK = totalReferenceTrades > 0 ? weightedSum / totalReferenceTrades : 0;
      if (pooledK >= (expectancyPercent ?? -Infinity)) countGE++;
    }
    randomEntryP = (1 + countGE) / (K + 1);
  }

  const trials = trialsOverride ?? cells.length * familyCount;

  const perCellPnl = perCellPooledPnl(perSymbol, cells.length);

  let deflatedSharpeResult: PooledStats['deflatedSharpe'] = null;
  if (n >= 2) {
    const perCellSharpes = perCellPnl.map((arr) => perPeriodSharpe(arr));
    const varianceOfTrialSharpes = sampleVariance(perCellSharpes);
    const observedSharpe = perPeriodSharpe(pnlPercents);
    const skewness = sampleSkewness(pnlPercents);
    const kurtosis = sampleKurtosis(pnlPercents);
    const radicand = psrRadicand(observedSharpe, skewness, kurtosis);
    const { benchmarkSharpe, probability } = deflatedSharpe({
      observedSharpe,
      numTrials: trials,
      varianceOfTrialSharpes,
      nObservations: n,
      skewness,
      kurtosis,
    });
    deflatedSharpeResult = {
      observedSharpe,
      benchmarkSharpe,
      probability: Number.isFinite(probability) ? probability : null,
      radicand,
      varianceOfTrialSharpes,
    };
  }

  let plateauResult: PooledStats['plateau'] = null;
  if (cells.length > 1) {
    const dims = Object.keys(cells[0]);
    let maxValuesPerDim = 1;
    for (const dim of dims) {
      const distinct = new Set(cells.map((c) => c[dim])).size;
      if (distinct > maxValuesPerDim) maxValuesPerDim = distinct;
    }
    const neighborRadius = 1 / (maxValuesPerDim - 1);

    const metrics = perCellPnl.map((arr) => (arr.length === 0 ? 0 : meanOf(arr)));
    let bestIndex = 0;
    for (let i = 1; i < metrics.length; i++) {
      if (metrics[i] > metrics[bestIndex]) bestIndex = i;
    }
    const bestParams = cells[bestIndex];

    const results = cells.map((params, i) => ({ params, metric: metrics[i] }));
    const { score, neighbors, bestMetric } = parameterPlateauScore(results, bestParams, neighborRadius);

    plateauResult = {
      score: Number.isFinite(score) ? score : null,
      neighbors,
      bestMetric,
      bestParams,
      neighborRadius,
    };
  }

  let stressTrades = 0;
  const stressPnlPercents: number[] = [];
  for (const s of perSymbol) {
    for (const w of s.windows) {
      if (w.stress) {
        stressTrades += w.stress.trades;
        stressPnlPercents.push(...w.stress.pnlPercents);
      }
    }
  }
  const stressExpectancyPercent = stressPnlPercents.length === 0 ? null : toFinite(meanOf(stressPnlPercents));

  const byYear = new Map<number, { trades: number; sum: number }>();
  for (const trade of trades) {
    const year = new Date(trade.exitTime).getUTCFullYear();
    const entry = byYear.get(year) ?? { trades: 0, sum: 0 };
    entry.trades += 1;
    entry.sum += trade.pnlPercent;
    byYear.set(year, entry);
  }
  const perYear = [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, { trades: yearTrades, sum }]) => ({
      year,
      trades: yearTrades,
      expectancyPercent: finiteOr(sum / yearTrades, 0),
    }));

  return {
    n,
    expectancyPercent,
    expectancyR,
    winRate,
    profitFactor,
    medianHoldBars,
    maxDrawdownPercent,
    bootstrapCi95,
    bootstrap,
    windowsTotal,
    windowsPositive,
    windowPositiveShare,
    symbolsTotal,
    symbolsPositive,
    symbolPositiveShare,
    benchmarkWindows: benchmarkWindows.length,
    randomEntryP,
    trials,
    deflatedSharpe: deflatedSharpeResult,
    plateau: plateauResult,
    stressTrades,
    stressExpectancyPercent,
    perYear,
  };
}

export function evaluateStrategyGates(pooled: PooledStats, interval: string): { gates: Gate[]; pass: boolean } {
  const gates: Gate[] = [];

  const sampleThreshold = minOosTradesFor(interval);
  gates.push({
    name: 'sample',
    pass: pooled.n >= sampleThreshold,
    value: pooled.n,
    threshold: sampleThreshold,
  });

  const ciLow = pooled.bootstrapCi95 ? pooled.bootstrapCi95[0] : null;
  gates.push({
    name: 'expectancy',
    pass: pooled.expectancyPercent !== null && pooled.expectancyPercent > 0 && ciLow !== null && ciLow > 0,
    value: ciLow,
    threshold: 0,
    note: `point estimate ${pooled.expectancyPercent === null ? 'null' : pooled.expectancyPercent}`,
  });

  gates.push({
    name: 'windows',
    pass: pooled.windowPositiveShare >= VALIDATION_PROTOCOL.minWindowPositiveShare,
    value: pooled.windowPositiveShare,
    threshold: VALIDATION_PROTOCOL.minWindowPositiveShare,
  });

  gates.push({
    name: 'symbols',
    pass: pooled.symbolPositiveShare >= VALIDATION_PROTOCOL.minSymbolPositiveShare,
    value: pooled.symbolPositiveShare,
    threshold: VALIDATION_PROTOCOL.minSymbolPositiveShare,
  });

  gates.push({
    name: 'timing',
    pass: pooled.randomEntryP !== null && pooled.randomEntryP < VALIDATION_PROTOCOL.maxRandomEntryP,
    value: pooled.randomEntryP,
    threshold: VALIDATION_PROTOCOL.maxRandomEntryP,
    ...(pooled.randomEntryP === null ? { note: 'benchmark disabled or no window had one' } : {}),
  });

  let trialsNote: string | undefined;
  if (pooled.deflatedSharpe === null) {
    trialsNote = 'fewer than two trades';
  } else if (pooled.deflatedSharpe.radicand <= 0) {
    trialsNote = 'moments outside the PSR domain';
  }
  const trialsValue = pooled.deflatedSharpe?.probability ?? null;
  gates.push({
    name: 'trials',
    pass: trialsValue !== null && trialsValue >= VALIDATION_PROTOCOL.minDeflatedSharpeProbability,
    value: trialsValue,
    threshold: VALIDATION_PROTOCOL.minDeflatedSharpeProbability,
    ...(trialsNote ? { note: trialsNote } : {}),
  });

  let plateauNote: string | undefined;
  let plateauPass: boolean;
  if (pooled.plateau === null) {
    plateauPass = true;
    plateauNote = 'single cell, not applicable';
  } else if (pooled.plateau.score === null) {
    plateauPass = false;
    plateauNote = 'best cell has non-positive expectancy';
  } else {
    plateauPass = pooled.plateau.score >= VALIDATION_PROTOCOL.minPlateauScore;
  }
  gates.push({
    name: 'plateau',
    pass: plateauPass,
    value: pooled.plateau?.score ?? null,
    threshold: VALIDATION_PROTOCOL.minPlateauScore,
    ...(plateauNote ? { note: plateauNote } : {}),
  });

  gates.push({
    name: 'stress',
    pass: pooled.stressExpectancyPercent !== null && pooled.stressExpectancyPercent > 0,
    value: pooled.stressExpectancyPercent,
    threshold: 0,
  });

  return { gates, pass: gates.every((g) => g.pass) };
}
