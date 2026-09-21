/**
 * The eight validation gates for the banded-exposure path.
 *
 * WHAT IS THE SAME AS THE DISCRETE PATH, AND WHAT IS NOT
 *
 * The thresholds in `VALIDATION_PROTOCOL` are fixed by the research program's
 * controller and are NOT retuned here. What changes is the unit of
 * observation: a discrete run's observation is a round trip, and an exposure
 * run's is a bar. Every statistic that counted trades therefore has to be
 * re-expressed, and the mapping is stated per gate below so a reader can check
 * it rather than trust it.
 *
 * `sample`     minOosTrades -> minimum bars held. A trade is a bet; a bar with
 *              non-zero exposure is also a bet, but a banded cell can hold a
 *              position for hundreds of bars and a minimum bar count alone
 *              would be satisfied by a handful of bets. So a second condition
 *              is added: the share of bars carrying non-zero exposure.
 * `expectancy` pooled expectancy per trade -> net per-period Sharpe with a
 *              bootstrap CI low bound above zero. Per-period, matching every
 *              other Sharpe in `src/lib/stats/`.
 * `windows`    unchanged, over the same windows.
 * `symbols`    positive-share -> a drop-one-symbol jackknife: the portfolio
 *              must stay positive with any single symbol removed. This
 *              targets the Phase 4b failure directly, where DOGE, LINK and SOL
 *              carried the result while BTC and ETH lost. A share treats a
 *              small symbol and a large one alike, and a jackknife does not.
 * `timing`     random-entry benchmark -> a circular block shuffle of the z
 *              column run through the identical machinery, NEVER a plain
 *              shuffle. `exposure-sim.circularBlockShuffle` carries the
 *              reasoning; the short version is that the factor is
 *              autocorrelated by construction and a null that destroys the
 *              property under test is a strawman that manufactures a pass.
 * `trials`     unchanged mechanism, computed on the exposure Sharpe.
 * `stress`     unchanged multipliers. This becomes the informative gate: the
 *              whole cost story of a banded exposure is turnover, so stressing
 *              fees and slippage is stressing the only thing that can kill it.
 * `plateau`    unchanged, over the new grid.
 *
 * BOOTSTRAP BLOCK LENGTH
 *
 * `meanBlockLen` is NOT `max(2, round(cbrt(n)))`. See
 * `exposure-sim.bootstrapBlockLength`: that rule is calibrated on a trade count
 * and would be badly undersized on autocorrelated bar returns, which is the
 * failure mode that manufactures a false pass. The realised block length is
 * carried on the report so a reviewer can check it rather than take the rule.
 */

import { bootstrapCi, maxDrawdownPercentOfPnl, meanOf } from '@/lib/stats/block-bootstrap';
import { deflatedSharpe, perPeriodSharpe, psrRadicand } from '@/lib/stats/deflated-sharpe';
import { parameterPlateauScore } from '@/lib/stats/plateau';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { sampleKurtosis, sampleSkewness } from '@/lib/stats/normal';

import {
  bootstrapBlockLength,
  circularBlockShuffle,
  simulateExposure,
  type ExposureGrid,
  type ExposureOptions,
  type ExposureResult,
  type ExposureSymbolInput,
} from './exposure-sim';

/** Same thresholds as the discrete path, except the sample gate, which is
 * restated in bars. See the module header for why each maps the way it does. */
export const EXPOSURE_PROTOCOL = {
  /** A bet is a held bar, and a cell could satisfy a bar count on very few
   * bets, so the exposure share is the real sample condition. Both are
   * reported; both must hold. */
  minBarsHeld: { default: 100, '5m': 300 } as Record<string, number>,
  minExposureShare: 0.5,
  minWindowPositiveShare: 0.6,
  maxTimingP: 0.05,
  minDeflatedSharpeProbability: 0.95,
  minPlateauScore: 0.6,
  stress: { feeMultiplier: 1.5, slippageMultiplier: 2 },
  bootstrap: { iterations: 1000, alpha: 0.05 },
  /** Draws for the circular block shuffle null. */
  timingShuffleDraws: 200,
} as const;

export const EXPOSURE_GATE_NAMES = [
  'sample',
  'expectancy',
  'windows',
  'symbols',
  'timing',
  'trials',
  'stress',
  'plateau',
] as const;
export type ExposureGateName = (typeof EXPOSURE_GATE_NAMES)[number];

export interface ExposureGate {
  name: ExposureGateName;
  pass: boolean;
  value: number | null;
  threshold: number;
  note?: string;
}

/** Per-window out-of-sample summary, the exposure analogue of a strategy
 * window's trade summary. */
export interface ExposureWindowResult {
  window: number;
  params: Record<string, number>;
  /** Bars in this window's out-of-sample test slice. */
  bars: number;
  /** A positive net mean per bar counts as a positive window, the same rule
   * the discrete path applies to a positive expectancy window. */
  positive: boolean;
  sharpe: number | null;
  meanReturnPercent: number | null;
}

export interface ExposurePerSymbolResult {
  symbol: string;
  bars: number;
  meanContribution: number | null;
  positive: boolean;
}

export interface ExposurePooledStats {
  /** Bars held: the number of out-of-sample bars carrying non-zero exposure. */
  barsHeld: number;
  /** All out-of-sample bars, exposure or not. */
  barsTotal: number;
  exposureShare: number;
  meanReturnPercent: number | null;
  /** Per-period Sharpe, not annualized, matching src/lib/stats. */
  sharpe: number | null;
  sharpeCi95: [number, number] | null;
  maxDrawdownPercent: number | null;
  bootstrap: { iterations: number; seed: number; meanBlockLen: number };
  windowsTotal: number;
  windowsPositive: number;
  windowPositiveShare: number;
  symbolsTotal: number;
  symbolsPositive: number;
  symbolPositiveShare: number;
  /** Drop-one-symbol jackknife: how many leave-one-out portfolios stayed
   * positive, and the worst of them. */
  jackknifeTotal: number;
  jackknifePositive: number;
  jackknifeWorstMeanReturnPercent: number | null;
  timingDraws: number;
  timingP: number | null;
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
  stressMeanReturnPercent: number | null;
  /** Turnover diagnostics: the cost story of the container. */
  totalTurnover: number;
  meanBarsBetweenRebalances: number | null;
}

/** Everything the pooling step needs about one symbol-window's out-of-sample
 * run. The harness produces these; the gates consume them. */
export interface ExposureCellRun {
  window: number;
  params: Record<string, number>;
  result: ExposureResult;
  symbols: readonly ExposureSymbolInput[];
  grid: ExposureGrid;
  options: ExposureOptions;
}

function toFinite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function minBarsHeldFor(interval: string): number {
  return EXPOSURE_PROTOCOL.minBarsHeld[interval] ?? EXPOSURE_PROTOCOL.minBarsHeld.default;
}

/**
 * Pool the selected grid cells into the statistics the gates read.
 *
 * `selected` is one entry per symbol-window that chose a cell, `allCells` is
 * every cell evaluated out of sample (for the plateau and the trials
 * variance), matching what the discrete path does -- except that here the
 * concatenation is a CONTINUOUS portfolio return series rather than a pool of
 * independent trades, because the cells are consecutive slices of one walk
 * forward over one universe.
 */
export function poolExposureResults(
  selected: readonly ExposureCellRun[],
  allCells: readonly ExposureCellRun[],
  universe: readonly string[],
  options: {
    interval: string;
    seed: number;
    trials: number;
    bootstrapIterations?: number;
    timingDraws?: number;
    benchmarkRandom?: () => number;
  }
): ExposurePooledStats {
  const bootstrapIterations =
    options.bootstrapIterations ?? EXPOSURE_PROTOCOL.bootstrap.iterations;
  const timingDraws = options.timingDraws ?? EXPOSURE_PROTOCOL.timingShuffleDraws;
  const random = options.benchmarkRandom ?? createSeededRandom(options.seed);

  const netReturns: number[] = [];
  const perSymbolContributions = new Map<string, number[]>();
  for (const symbol of universe) perSymbolContributions.set(symbol, []);

  let barsHeld = 0;
  let barsTotal = 0;
  let totalTurnover = 0;
  const spacings: number[] = [];

  for (const cell of selected) {
    for (let i = 0; i < cell.result.netReturns.length; i++) {
      const r = cell.result.netReturns[i];
      if (!Number.isFinite(r)) continue;
      netReturns.push(r);
      barsTotal++;
      if (cell.result.grossExposure[i] > 0) barsHeld++;
    }
    totalTurnover += cell.result.turnover.reduce((a, b) => a + b, 0);
    if (Number.isFinite(cell.result.meanBarsBetweenRebalances)) {
      spacings.push(cell.result.meanBarsBetweenRebalances);
    }
    for (const s of cell.result.perSymbol) {
      const bucket = perSymbolContributions.get(s.symbol);
      if (bucket) bucket.push(...s.returnContribution.filter((v) => Number.isFinite(v)));
    }
  }

  const meanReturnPercent = netReturns.length > 0 ? meanOf(netReturns) * 100 : null;
  const sharpe = netReturns.length > 1 ? toFinite(perPeriodSharpe(netReturns)) : null;

  // Block length from the holding horizon, never cbrt(n). Imported lazily to
  // keep this module's import list honest about where the rule lives.
  const meanBarsBetweenRebalances =
    spacings.length > 0 ? meanOf(spacings) : Number.POSITIVE_INFINITY;
  const meanBlockLen = bootstrapBlockLength(meanBarsBetweenRebalances);

  let sharpeCi95: [number, number] | null = null;
  if (netReturns.length >= 2) {
    const ci = bootstrapCi(netReturns, perPeriodSharpe, {
      iterations: bootstrapIterations,
      meanBlockLen,
      seed: options.seed,
      alpha: EXPOSURE_PROTOCOL.bootstrap.alpha,
    });
    sharpeCi95 = [ci.low, ci.high];
  }

  // Windows: one positive window per cell whose out-of-sample mean is positive.
  let windowsTotal = 0;
  let windowsPositive = 0;
  for (const cell of selected) {
    const finite = cell.result.netReturns.filter((v) => Number.isFinite(v));
    windowsTotal++;
    if (finite.length > 0 && meanOf(finite) > 0) windowsPositive++;
  }

  // Symbols: a symbol is positive when its own summed contribution is.
  let symbolsTotal = 0;
  let symbolsPositive = 0;
  for (const symbol of universe) {
    const contributions = perSymbolContributions.get(symbol) ?? [];
    if (contributions.length === 0) continue;
    symbolsTotal++;
    if (meanOf(contributions) > 0) symbolsPositive++;
  }

  // Drop-one-symbol jackknife: rebuild the portfolio net return without each
  // symbol in turn. The per-symbol contributions and the shared funding and
  // cost terms are all that the portfolio return is, so removing a symbol is
  // subtracting its contribution and re-summing -- no re-simulation needed,
  // which is also why the jackknife cannot drift from the headline number.
  let jackknifePositive = 0;
  let jackknifeTotal = 0;
  let jackknifeWorst: number | null = null;
  for (const symbol of universe) {
    const contributions = perSymbolContributions.get(symbol);
    if (!contributions || contributions.length === 0) continue;
    jackknifeTotal++;
    const without = subtractPerSymbol(selected, symbol);
    const mean = without.length > 0 ? meanOf(without) : Number.NaN;
    if (Number.isFinite(mean) && mean > 0) jackknifePositive++;
    if (Number.isFinite(mean) && (jackknifeWorst === null || mean < jackknifeWorst)) {
      jackknifeWorst = mean;
    }
  }

  // Timing: circular block shuffle of every symbol's z column, run through the
  // identical machinery, and count how often the shuffled portfolio's mean
  // return reaches the observed one. One-sided on the magnitude, because the
  // container is allowed to be short and the question is "is this better than
  // a signal that only shares the original's autocorrelation".
  let timingP: number | null = null;
  if (selected.length > 0 && netReturns.length > 0) {
    const observed = meanOf(netReturns);
    const blockLen = Math.max(2, Math.round(meanBlockLen));
    let atLeastAsGood = 0;
    for (let draw = 0; draw < timingDraws; draw++) {
      let mean = 0;
      let count = 0;
      for (const cell of selected) {
        const shuffled = cell.symbols.map((s) => ({
          ...s,
          z: circularBlockShuffle(s.z, blockLen, random),
        }));
        const sim = simulateExposure(shuffled, cell.grid, cell.options);
        for (const r of sim.netReturns) {
          if (!Number.isFinite(r)) continue;
          mean += r;
          count++;
        }
      }
      const drawMean = count > 0 ? mean / count : Number.NaN;
      // Two-sided on the magnitude: a shuffled signal that is either much
      // better or much worse than the real one is not evidence of skill, and
      // counting both tails is what a permutation test of "same distribution"
      // means.
      if (Number.isFinite(drawMean) && Math.abs(drawMean) >= Math.abs(observed)) atLeastAsGood++;
    }
    timingP = timingDraws > 0 ? atLeastAsGood / timingDraws : null;
  }

  // Trials: deflated Sharpe on the exposure Sharpe series, with the variance
  // taken across the grid cells' own Sharpes exactly as the discrete path does.
  const cellSharpes = allCells
    .map((c) => perPeriodSharpe(c.result.netReturns.filter((v) => Number.isFinite(v))))
    .filter((v) => Number.isFinite(v));
  const varianceOfTrialSharpes =
    cellSharpes.length > 1
      ? variance(cellSharpes)
      : 0;
  let deflated: ExposurePooledStats['deflatedSharpe'] = null;
  if (sharpe !== null && netReturns.length > 1) {
    const skewness = sampleSkewness(netReturns);
    const kurtosis = sampleKurtosis(netReturns);
    const ds = deflatedSharpe({
      observedSharpe: sharpe,
      numTrials: options.trials,
      varianceOfTrialSharpes,
      nObservations: netReturns.length,
      skewness,
      kurtosis,
    });
    deflated = {
      observedSharpe: sharpe,
      benchmarkSharpe: ds.benchmarkSharpe,
      probability: toFinite(ds.probability),
      // Exposed raw because a non-positive radicand is the documented way the
      // PSR formula leaves its domain, and NaN probability alone would not say
      // whether the moments or the trial count caused it.
      radicand: psrRadicand(sharpe, skewness, kurtosis),
      varianceOfTrialSharpes,
    };
  }

  // Plateau across the grid, on each cell's out-of-sample mean return.
  let plateau: ExposurePooledStats['plateau'] = null;
  if (allCells.length > 0) {
    const results = allCells.map((c) => {
      const finite = c.result.netReturns.filter((v) => Number.isFinite(v));
      return { params: c.params, metric: finite.length > 0 ? meanOf(finite) : 0 };
    });
    let best = results[0];
    for (const r of results) if (r.metric > best.metric) best = r;
    const score = parameterPlateauScore(results, best.params, 1);
    plateau = {
      score: toFinite(score.score),
      neighbors: score.neighbors,
      bestMetric: toFinite(score.bestMetric) ?? 0,
      bestParams: best.params,
      neighborRadius: 1,
    };
  }

  // Stress: the same selected cells run with the stress multipliers. The
  // harness supplies these as cells whose options already carry them; when it
  // does not, this reports null rather than silently reusing the unstressed
  // number, which would pass the gate by construction.
  const stressReturns: number[] = [];
  for (const cell of selected) {
    if (
      (cell.options.feeMultiplier ?? 1) === 1 &&
      (cell.options.slippageMultiplier ?? 1) === 1
    ) {
      continue;
    }
    for (const r of cell.result.netReturns) if (Number.isFinite(r)) stressReturns.push(r);
  }
  const stressMeanReturnPercent =
    stressReturns.length > 0 && selected.some((c) => c.options.feeMultiplier !== undefined)
      ? meanOf(stressReturns) * 100
      : null;

  // Real mark-to-market drawdown, which the discrete path could not produce:
  // its `maxDrawdownPercent` concatenates ten independent single-symbol runs
  // onto one synthetic path (`strategy-gates.ts`). Here the series genuinely
  // is one portfolio held continuously, so the drawdown is a real one. It is
  // still reported rather than gated, per the Phase 5 spec.
  const maxDrawdownPercent =
    netReturns.length > 0
      ? toFinite(maxDrawdownPercentOfPnl(equityDeltasFromReturns(netReturns, 10000), 10000))
      : null;

  return {
    barsHeld,
    barsTotal,
    exposureShare: barsTotal > 0 ? barsHeld / barsTotal : 0,
    meanReturnPercent,
    sharpe,
    sharpeCi95,
    maxDrawdownPercent,
    bootstrap: { iterations: bootstrapIterations, seed: options.seed, meanBlockLen },
    windowsTotal,
    windowsPositive,
    windowPositiveShare: windowsTotal > 0 ? windowsPositive / windowsTotal : 0,
    symbolsTotal,
    symbolsPositive,
    symbolPositiveShare: symbolsTotal > 0 ? symbolsPositive / symbolsTotal : 0,
    jackknifeTotal,
    jackknifePositive,
    jackknifeWorstMeanReturnPercent: jackknifeWorst === null ? null : jackknifeWorst * 100,
    timingDraws,
    timingP,
    trials: options.trials,
    deflatedSharpe: deflated,
    plateau,
    stressMeanReturnPercent,
    totalTurnover,
    meanBarsBetweenRebalances: Number.isFinite(meanBarsBetweenRebalances)
      ? meanBarsBetweenRebalances
      : null,
  };
}

/** Portfolio net return per bar with one symbol's contribution removed. */
function subtractPerSymbol(
  selected: readonly ExposureCellRun[],
  symbol: string
): number[] {
  const out: number[] = [];
  for (const cell of selected) {
    const index = cell.result.perSymbol.findIndex((s) => s.symbol === symbol);
    if (index < 0) continue;
    for (let i = 0; i < cell.result.netReturns.length; i++) {
      const net = cell.result.netReturns[i];
      const contribution = cell.result.perSymbol[index].returnContribution[i];
      if (!Number.isFinite(net)) continue;
      // A missing contribution on a live bar means the symbol was not part of
      // that bar; treat it as zero removal rather than dropping the bar.
      out.push(net - (Number.isFinite(contribution) ? contribution : 0));
    }
  }
  return out;
}

/**
 * Compound per-bar returns into a mark-to-market equity path, then hand
 * `maxDrawdownPercentOfPnl` the DELTAS it actually wants.
 *
 * Compounded rather than summed: a per-bar return is a fraction of the equity
 * at that bar, and adding them would let a run of losses take equity below
 * zero on paper. And the helper is named for what it takes -- a list of PnL
 * increments added to a running equity -- so passing it the equity levels
 * themselves gives a wrong answer (it walks from `startEquity` adding each
 * level, so its curve never matches the real one; on a rising series the
 * reported drawdown comes out 0).
 */
function equityDeltasFromReturns(returns: readonly number[], startEquity: number): number[] {
  const out: number[] = [];
  let equity = startEquity;
  for (const r of returns) {
    const next = equity * (1 + r);
    out.push(next - equity);
    equity = next;
  }
  return out;
}

function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1);
}

/**
 * Evaluate the eight gates. Thresholds are the controller's and are not
 * retuned here; each gate's note says which statistic it read and why.
 */
export function evaluateExposureGates(
  pooled: ExposurePooledStats,
  interval: string
): { gates: ExposureGate[]; pass: boolean } {
  const gates: ExposureGate[] = [];
  const minBars = minBarsHeldFor(interval);

  gates.push({
    name: 'sample',
    pass: pooled.barsHeld >= minBars && pooled.exposureShare >= EXPOSURE_PROTOCOL.minExposureShare,
    value: pooled.barsHeld,
    threshold: minBars,
    note:
      `${pooled.barsHeld} bars held of ${pooled.barsTotal} ` +
      `(exposure share ${pooled.exposureShare.toFixed(3)} against ` +
      `${EXPOSURE_PROTOCOL.minExposureShare}). A bar count alone would be met by a ` +
      'handful of long holds, so the share is the real sample condition.',
  });

  gates.push({
    name: 'expectancy',
    pass:
      pooled.sharpeCi95 !== null &&
      pooled.sharpeCi95[0] > 0 &&
      (pooled.meanReturnPercent ?? 0) > 0,
    value: pooled.sharpeCi95 === null ? null : pooled.sharpeCi95[0],
    threshold: 0,
    note:
      'Per-period Sharpe CI low bound above zero, from a stationary block ' +
      `bootstrap of block length ${pooled.bootstrap.meanBlockLen} (set from the holding ` +
      'horizon, not cbrt(n)).',
  });

  gates.push({
    name: 'windows',
    pass: pooled.windowPositiveShare >= EXPOSURE_PROTOCOL.minWindowPositiveShare,
    value: pooled.windowPositiveShare,
    threshold: EXPOSURE_PROTOCOL.minWindowPositiveShare,
    note: `${pooled.windowsPositive} of ${pooled.windowsTotal} windows positive.`,
  });

  gates.push({
    name: 'symbols',
    pass:
      pooled.jackknifeTotal > 0 &&
      pooled.jackknifePositive === pooled.jackknifeTotal &&
      pooled.symbolPositiveShare >= EXPOSURE_PROTOCOL.minWindowPositiveShare,
    value: pooled.jackknifeTotal > 0 ? pooled.jackknifePositive / pooled.jackknifeTotal : null,
    threshold: 1,
    note:
      `Drop-one-symbol jackknife: ${pooled.jackknifePositive} of ${pooled.jackknifeTotal} ` +
      'leave-one-out portfolios stayed positive (worst ' +
      `${pooled.jackknifeWorstMeanReturnPercent === null ? 'n/a' : pooled.jackknifeWorstMeanReturnPercent.toFixed(4)}` +
      `%/bar). This is the gate that targets the Phase 4b failure where three symbols carried the result.`,
  });

  gates.push({
    name: 'timing',
    pass: pooled.timingP !== null && pooled.timingP <= EXPOSURE_PROTOCOL.maxTimingP,
    value: pooled.timingP,
    threshold: EXPOSURE_PROTOCOL.maxTimingP,
    note:
      `Circular block shuffle of the z column, ${pooled.timingDraws} draws, two-sided ` +
      'on the magnitude. Never a plain shuffle: the factor is autocorrelated by ' +
      'construction and a null that destroys that would be a strawman.',
  });

  gates.push({
    name: 'trials',
    pass:
      pooled.deflatedSharpe !== null &&
      (pooled.deflatedSharpe.probability ?? 0) >= EXPOSURE_PROTOCOL.minDeflatedSharpeProbability,
    value: pooled.deflatedSharpe?.probability ?? null,
    threshold: EXPOSURE_PROTOCOL.minDeflatedSharpeProbability,
    note: `Deflated Sharpe over ${pooled.trials} trials.`,
  });

  // Pushed in EXPOSURE_GATE_NAMES order. The order is part of the report's
  // contract, so a reader can compare two runs gate for gate without reading
  // names.
  gates.push({
    name: 'stress',
    pass: pooled.stressMeanReturnPercent !== null && pooled.stressMeanReturnPercent > 0,
    value: pooled.stressMeanReturnPercent,
    threshold: 0,
    note:
      `Fees x${EXPOSURE_PROTOCOL.stress.feeMultiplier}, slippage x${EXPOSURE_PROTOCOL.stress.slippageMultiplier}. ` +
      'Turnover is the entire cost story of a banded exposure, so this is the informative gate.',
  });

  gates.push({
    name: 'plateau',
    pass:
      pooled.plateau === null ||
      (pooled.plateau.score ?? 0) >= EXPOSURE_PROTOCOL.minPlateauScore,
    value: pooled.plateau?.score ?? null,
    threshold: EXPOSURE_PROTOCOL.minPlateauScore,
    note:
      pooled.plateau === null
        ? 'No grid evaluated.'
        : `${pooled.plateau.neighbors} neighbours around the best cell.`,
  });

  return { gates, pass: gates.every((g) => g.pass) };
}

/** Every statistic the gates read that can come out non-finite is nulled
 * rather than left as NaN, because JSON.stringify turns NaN into null silently
 * and the report would then read as a real value. Exported for the tests. */
export const __testing = { toFinite, variance };
