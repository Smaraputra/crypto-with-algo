/**
 * The eight validation gates for the banded-exposure path.
 *
 * PHASE 5 RESULT, 2026-09-21. Six runs, all on dataset `e84cd66dbe01` with the
 * lockbox applied, ten symbols, 6 windows, `--trials 36`, perp prices for the
 * returns, the funding and the factor column. Reports
 * `exposure-<factor>-<interval>-p5c.json`.
 *
 * | factor           | interval | bars held  | mean %/bar | CI low  | timing p | gates failed |
 * | ---              | ---      | ---        | ---        | ---     | ---      | ---          |
 * | `positioningZ180`| 1d       | 577/732    | -0.0148    | -0.0853 | 1.000    | 6 of 8       |
 * | `positioningZ360`| 1d       | 564/750    | +0.0042    | -0.0394 | 1.000    | 5 of 8       |
 * | `positioningZ720`| 1d       | 595/750    | +0.0026    | -0.0554 | 1.000    | 5 of 8       |
 * | `positioningZ180`| 4h       | 5237/5340  | -0.0008    | -0.0266 | 0.865    | 7 of 8       |
 * | `positioningZ360`| 4h       | 5237/5340  | -0.0027    | -0.0278 | 0.725    | 7 of 8       |
 * | `positioningZ720`| 4h       | 5206/5340  | -0.0029    | -0.0288 | 0.565    | 7 of 8       |
 *
 * The pre-registered falsification criterion therefore fires: banded exposure
 * fails expectancy (every confidence interval spans zero) AND the
 * drop-one-symbol jackknife (1.0 at 1d, 0.0 at 4h), which is the pair the phase
 * fixed in advance as the signal to close the backtest track on this dataset.
 * The 1d runs are flat rather than negative, and `positioningZ360` and
 * `positioningZ720` are mildly positive there, but the interval is what decides
 * and neither clears it.
 *
 * REVIEW M8, 2026-10-01: the three 1d rows above were computed while
 * `simulateExposure` charged ONE funding settlement per bar from the per-8h
 * rate, a two-thirds undercharge on every 1d bar (it spans three settlements).
 * Fixed in `exposure-sim.ts`, not re-run. The 4h rows cross at most one
 * boundary per bar and are unaffected. The fade is mostly short when the crowd
 * is long, and a short RECEIVES positive funding, so the "mildly positive" 1d
 * readings may owe part of their sign to the undercharge as well as part of
 * their size; either way they stay inside their intervals and the verdict
 * stands.
 *
 * TWO HONEST CAVEATS, both recorded because they bound what this can be said to
 * show. First, the BAND WAS NEVER SELECTED: `band = 0` won all 6 windows at 4h
 * and 5 of 6 at 1d in the final grid (and 11 of 12 in the first, discarded one).
 * So the optimizer chose the no-band control almost everywhere, and this is
 * therefore better read as "the factor has no edge carried by any cell of this
 * grid" than as a clean comparison of a banded container against a bandless
 * one. Second, `timing p = 1.000` at 1d is uninformative rather than damning:
 * the two-sided magnitude comparison charges every shuffled draw against an
 * observed mean of nearly zero, so the null is always "at least as extreme".
 * The 4h values (0.565 to 0.865) say the same thing more legibly.
 *
 * Both survive as findings in their own right: a per-period Sharpe prefers tidy
 * iid returns, which a continuously rebalanced book has and a wide band does
 * not, so the selection metric is biased against exactly the container this
 * phase was built to test.
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
 *
 * PHASE 3 PLAN 2 PRE-REGISTRATION, 2026-09-27 (committed before any rank
 * container code). Hypothesis: a dollar-neutral rank book across the ten
 * USDT-M perpetuals, long the low readings and short the high readings of a
 * cross-sectional survivor, pays standard taker costs at 1h and 4h.
 *
 * Factors and predicted sign (factorSign is the sign under which a HIGH
 * reading is LONG; every one below is -1, contrarian):
 *   realizedVol20            -1  primary. cs IC 1h h32 -0.0745 (q 0.96, s 1.00), 4h h32 -0.0788 (q 0.91, s 1.00)
 *   fundingRate              -1  second, only if the primary passes expectancy at either interval. 1h h32 -0.026 (q 0.91, s 0.90), 4h (q 0.80, s 1.00)
 *   topTraderPositionRatio   -1  third, same condition. 1h h32 -0.029 (q 0.81, s 0.90), 4h (q 0.81, s 0.80)
 *
 * Grid, fixed: scheme in {topBottom k=1, topBottom k=2, linearRank} x
 * bandFraction in {0, 0.25, 0.5}, nine cells per run; band is the fraction of
 * the scheme's largest weight (0.5 for k=1, 0.25 for k=2, 4.5/25 = 0.18 for
 * linearRank on ten symbols). Smoothing 0. Minimum cross-section 5 symbols.
 * Six runs at most (three factors x two intervals): --trials 54 for every run.
 * Windows 6 rolling, train fraction 0.4, as Phase 5. Selection on net mean
 * return per bar. Costs: standard taker plus study slippage on turnover.
 * Bootstrap block: bars between rebalances, floor 32.
 *
 * Predicted magnitude for the primary at 1h: gross 0.2 to 0.4% per 32 bars
 * per unit gross (cross-sectionally demeaned 32-bar return sd 2.62% x 2 x
 * 0.0745 = 0.39% as the decile upper bound), turnover well under one full
 * rotation per 32 bars, net mean return per bar positive with the Sharpe CI
 * clear of zero; a band above 0 selected in most windows; the drop-BTCUSDT
 * jackknife still positive.
 *
 * KILL CRITERION: if realizedVol20 fails the expectancy gate (Sharpe CI low
 * not above zero) at BOTH 1h and 4h, the cross-sectional axis closes on this
 * dataset and neither other factor runs.
 *
 * Robustness reads at the selected cell of every run that passes expectancy,
 * reported and never selected on: alts only (--exclude-symbols BTCUSDT),
 * maker fill (--fill maker: maker fee, zero slippage), fee profile bnb, and
 * the per-leg split. Nothing here changes live scoring or configVersion.
 *
 * PHASE 3 PLAN 2 RESULT, 2026-09-28. Dataset e84cd66dbe01, lockbox on, ten
 * symbols, six rolling windows, train fraction 0.4, standard taker plus study
 * slippage on turnover, selection on net mean return per bar, --trials 54.
 *
 * BYTE-IDENTITY CONTROL. The recorded Phase 5 row
 * (exposure-positioningZ360-4h-p5c.json, 2026-09-21) does NOT reproduce on
 * the branch, and the reason is vintage, not code: the branch run
 * (exposure-positioningZ360-4h-control.json, image f5625a2) matches the
 * recorded report on selected params, bars held 5237/5340, total turnover
 * 94.01456912315177 and bars per rebalance 1.0221151680472687, while every
 * return-side number moved (mean -0.0026737 to -0.0023714 %/bar, Sharpe CI
 * [-0.027782, 0.018162] to [-0.028749, 0.018609], timing p 0.725 to 0.75,
 * symbols positive 3 to 4). Identical trades with different returns is the
 * signature of the causal snapshot join deployed 2026-09-25 (PR #43), which
 * already breaks reproduction of pre-2026-09-25 snapshot-derived numbers.
 * The valid control is pre-branch main (c47e775) on today's join:
 * exposure-positioningZ360-4h-main.json is digit-identical to the branch
 * control on all 25 pre-existing pooled fields, every gate, every window and
 * every per-symbol row (mean -0.0023714498866813038 %/bar both); the branch
 * adds only meanAbsNetExposure, longLegMeanReturnPercent,
 * shortLegMeanReturnPercent, jackknifeWithoutBtcMeanReturnPercent and the
 * mode, fill, minCrossSection, selectMetric metadata. The post-join
 * reference for positioningZ360 4h is therefore -0.0023714 %/bar, CI
 * [-0.028749, 0.018609], timing p 0.75, 7 of 8 failed; the Phase 5 table
 * above is the pre-join vintage.
 *
 * PRIMARY RUNS, realizedVol20, factorSign -1 (long low relative volatility,
 * short high):
 *
 * | interval | image    | bars held/total | mean %/bar | Sharpe    | Sharpe CI95              | drawdown % | windows+ | symbols+ | jackknife+ (worst) | without BTC | timing p (draws) | dsp     | plateau | stress mean | turnover | bars/rebal | long leg  | short leg | mean abs net exposure | gates failed |
 * | ---      | ---      | ---             | ---:       | ---:      | ---                      | ---:       | ---      | ---      | ---                 | ---:        | ---               | ---:    | ---     | ---:        | ---:     | ---:       | ---:      | ---:      | ---:                  | ---          |
 * | 4h       | f5625a2  | 5856/5856       | -0.006881  | -0.012569 | [-0.038117, 0.013164]    | 53.3       | 3/6      | 6/10     | 0/10 (-0.010796)    | -0.005704   | 0.935 (200)       | 0.0702  | n/a     | -0.011261   | 570.0    | 14.41      | +0.005838 | -0.005892 | 9.6e-18               | expectancy, windows, symbols, timing, trials, stress, plateau |
 * | 1h       | 29f01df  | 23532/23532     | -0.006305  | -0.023461 | [-0.035073, -0.011112]   | 79.5       | 1/6      | 4/10     | 0/10 (-0.007170)    | -0.006548   | 1.000 (200)       | 5.2e-09 | n/a     | -0.010011   | 1586.0   | 11.61      | +0.001410 | -0.002379 | 1.0e-17               | expectancy, windows, symbols, timing, trials, stress, plateau |
 *
 * The without-BTC column removes BTCUSDT's return contribution only: its
 * share of turnover cost is not removed and the residual book is not dollar
 * neutral, so it is a contribution-removal statistic, not the alts-only
 * re-run the pre-registration lists separately (which did not run because
 * nothing passed).
 *
 * Selected cells per window: 4h linearRank with band fraction 0.25 (window 0)
 * and 0.5 (windows 1 to 4), topBottom k=1 band 0 (window 5); 1h linearRank
 * band fraction 0.5 in all six windows. The band was selected (unlike Phase
 * 5): 14.4 bars between rebalances at 4h, 11.6 at 1h.
 *
 * Per-window means (%/bar): 4h -0.03346, +0.01607, -0.03728, +0.00796,
 * +0.01134, -0.00591 (976 bars each); 1h -0.01424, +0.00043, -0.01316,
 * -0.00261, -0.00403, -0.00422 (3922 bars each).
 *
 * Per-symbol mean contribution (%/bar, positive?): 4h ADA +0.00036 yes, AVAX
 * 0.0 yes, BNB +0.00285 yes, BTC -0.00118 no, DOGE -0.00524 no, DOT +0.00392
 * yes, ETH +0.00206 yes, LINK +0.00285 yes, SOL -0.00447 no, XRP -0.0012 no.
 * 1h ADA -0.00036 no, AVAX -0.00026 no, BNB +0.00087 yes, BTC +0.00024 yes,
 * DOGE -0.00093 no, DOT +0.00065 yes, ETH -0.00013 no, LINK +0.00086 yes,
 * SOL -0.00082 no, XRP -0.00109 no.
 *
 * Cost arithmetic: 4h 570 turnover units x 0.0007 per unit (0.05% taker + 2
 * bps) over 5856 bars = 0.0068 %/bar, so gross is about zero (legs +0.0058
 * and -0.0059); 1h 1586 x 0.0008 (0.05% + 3 bps) over 23532 bars = 0.0054
 * %/bar, so gross is about -0.001 %/bar.
 *
 * Loader note: at 1h every symbol had exactly one perp bar absent from the
 * spot grid (the same hour, 2023-03-24T13:00Z), dropped by the intersection
 * and recorded as perpBarsOffSpotGrid: 1 per symbol; 39407 perp bars per
 * symbol remain. Phase 5 never ran 1h, which is why the guard had never
 * fired.
 *
 * VERDICT AGAINST THE PRE-REGISTRATION. Predictions: gross 0.2 to 0.4% per
 * 32 bars per unit gross at 1h, net mean return per bar positive with the
 * Sharpe CI clear of zero, a band above 0 selected in most windows, the
 * drop-BTC jackknife positive. Observed: the band prediction held (band 0.5
 * in every 1h window, in five of six at 4h); everything else failed. Gross
 * at 1h is about -0.001 %/bar (-0.03% per 32 bars) against a predicted +0.2
 * to +0.4%; the Sharpe CI at 1h is entirely below zero; the drop-BTC
 * jackknife is negative at both intervals. KILL CRITERION FIRES:
 * realizedVol20 fails the expectancy gate at both 1h and 4h, so the
 * cross-sectional axis closes on this dataset; fundingRate and
 * topTraderPositionRatio were not run, and no robustness read applies
 * because no run passed. Spot checks: 4h BTCUSDT window 2 reproduced (params
 * linearRank band 0.5, 976 bars, mean -0.03728195892975744 %/bar); 1h
 * BTCUSDT window 2 reproduced (params linearRank band 0.5, 3922 bars, mean
 * -0.013161281383872741 %/bar). The timing p values (1.000 at 1h, 0.935 at
 * 4h) are uninformative at this cost-to-gross ratio: the observed mean is
 * almost entirely turnover cost, and the per-symbol shuffle likely churns
 * the book harder, so the null draws pay at least as much cost, the same
 * caveat Phase 5 recorded at 1d. The conclusion rests on the expectancy
 * gate.
 *
 * THE FINDING WORTH KEEPING (observation, not a change to the
 * pre-registration). A rank IC of -0.0745 (1h) and -0.0788 (4h) with quarter
 * agreement above 0.9 did not become a positive gross spread in an
 * equal-dollar rank book. The factor sorts symbols by their own return
 * volatility, so the short leg (high vol) moves more than the long leg: a
 * Spearman IC counts a bar where the high-vol names outperform by 5% the
 * same as a bar where they underperform by 0.1%, while the book's P&L does
 * not. Frequent small wins and rare large losses net to about zero at both
 * intervals. The frontier conversion 2 x IC x sd assumes a scale-free
 * relationship and does not hold for a factor that sorts on the return
 * scale; this is the same lesson as the btcLeadLag hold-profile caveat in a
 * different coat. A volatility-scaled (risk-parity) weighting is the
 * natural next container variant and is NOT run in this phase (the grid was
 * fixed in advance); it would need a new pre-registration. The equal-dollar
 * result says only that the rank ordering carries information an
 * equal-dollar weighting cannot monetise, and says nothing about what a
 * volatility-scaled weighting would earn, so it should be written up as a
 * bounded question, not a promise.
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
  /** Mean of |netExposure| over the concatenated selected bars. Near zero for
   * a rank scheme, which rebalances the whole book to sum to zero on every
   * complete bar; nonzero for `tanh`, whose per-symbol targets have no such
   * constraint. */
  meanAbsNetExposure: number;
  meanReturnPercent: number | null;
  /** Per-bar return contribution summed over symbols held long, pooled and
   * expressed in percent like `meanReturnPercent`. Null only when there are
   * no bars at all (same condition as `meanReturnPercent`). */
  longLegMeanReturnPercent: number | null;
  /** Per-bar return contribution summed over symbols held short, pooled and
   * expressed in percent like `meanReturnPercent`. */
  shortLegMeanReturnPercent: number | null;
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
  /** The drop-one-symbol jackknife, restricted to BTCUSDT: the pooled mean
   * return with BTCUSDT's own contribution subtracted out. Null when
   * BTCUSDT is not in `universe`, never computed from cell membership alone. */
  jackknifeWithoutBtcMeanReturnPercent: number | null;
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
  // Net exposure, and the two legs' return contributions, concatenated in
  // lockstep with `netReturns` -- same cell, same index `i`, same finiteness
  // gate -- so a pooled mean of any one of them lines up bar for bar with the
  // others. This is what makes the per-leg identity (long + short = net -
  // cost - funding) hold on the POOLED means, not just per bar.
  const netExposureAbs: number[] = [];
  const longLegValues: number[] = [];
  const shortLegValues: number[] = [];
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
      netExposureAbs.push(Math.abs(cell.result.netExposure[i]));
      longLegValues.push(cell.result.longLegReturns[i]);
      shortLegValues.push(cell.result.shortLegReturns[i]);
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
  const meanAbsNetExposure = netExposureAbs.length > 0 ? meanOf(netExposureAbs) : 0;
  const longLegMeanReturnPercent =
    longLegValues.length > 0 ? meanOf(longLegValues) * 100 : null;
  const shortLegMeanReturnPercent =
    shortLegValues.length > 0 ? meanOf(shortLegValues) * 100 : null;
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

  // Drop-BTC jackknife: the same machinery, restricted to BTCUSDT. Gated on
  // `universe` membership, not on whether a selected cell happens to have
  // traded it -- BTCUSDT absent from the universe means the question does
  // not apply, regardless of what any individual cell's symbols were.
  const jackknifeWithoutBtcMeanReturnPercent = universe.includes('BTCUSDT')
    ? (() => {
        const without = subtractPerSymbol(selected, 'BTCUSDT');
        return without.length > 0 ? meanOf(without) * 100 : null;
      })()
    : null;

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
    meanAbsNetExposure,
    meanReturnPercent,
    longLegMeanReturnPercent,
    shortLegMeanReturnPercent,
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
    jackknifeWithoutBtcMeanReturnPercent,
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
