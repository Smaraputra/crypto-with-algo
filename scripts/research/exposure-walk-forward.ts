/**
 * Walk-forward, grid and selection for the banded-exposure path.
 *
 * Split out of `exposure-harness.ts` so the geometry and the selection rule can
 * be unit tested without a dataset on disk.
 *
 * THE DEFECT THIS MODULE EXISTS TO PREVENT, AND BOTH HALVES OF THE FIX
 *
 * `simulateExposure` owns its smoothing: it calls `trailingMean(s.z, grid.smoothing)`,
 * which returns NaN until the window is full. Handing it a WINDOW SLICE with a
 * non-zero `smoothing` therefore leaves the head of EVERY out-of-sample window
 * with no reading, which is a quarter of a 124-bar 1d window, and makes the
 * same grid cell mean a different signal in-sample than out-of-sample. That is
 * the defect `research-columns.ts`'s header was written to kill, one level up.
 *
 * The fix has TWO halves, and doing only the first one changes nothing:
 *
 *   1. PRE-SMOOTH `z` once over the full series and hand `simulateExposure`
 *      `smoothing: 0`, so a slice inherits warmed history instead of
 *      restarting it. The logical cell still records `smoothing` as a grid
 *      parameter (the report and the plateau need it); only the grid given to
 *      the simulator is pinned.
 *
 *   2. TRIM PAST `rawWarmup + smoothing - 1`. Pre-smoothing does not make the
 *      column finite any earlier: a trailing mean needs `smoothing` finite
 *      readings either way. So on a run trimmed exactly to the raw column's
 *      first reading, the smoothed column is STILL NaN for another
 *      `smoothing - 1` bars, and a window starting there still sits its head
 *      out. `maxSmoothingWarmupBars` is what clears that.
 *
 * Because the whole grid shares one trim, the run trims to the LONGEST
 * smoothing in the grid, which costs `max(smoothing) - 1` bars (31) and makes
 * every cell tradeable from the first window bar. The harness asserts the
 * smoothed column is finite at its first index, so a future caller cannot
 * apply half the fix and get a silently dead window head.
 */

import type { OHLCV } from '@/types/market';
import { perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { calculateWindows } from '@/lib/optimization/walk-forward';
import type { FeeProfileName } from '@/lib/backtest/cost-model';

import {
  FACTOR_DECAY_HORIZON_BARS,
  maxRankWeight,
  simulateExposure,
  trailingMean,
  type ExposureGrid,
  type ExposureOptions,
  type ExposureResult,
  type ExposureSymbolInput,
} from './exposure-sim';
import { minBarsHeldFor, type ExposureCellRun } from './exposure-gates';

/**
 * The grid: band x zScale x smoothing, with `band = 0` as the internal control
 * (the same factor with no band, so the band's contribution is measurable
 * rather than assumed).
 *
 * THE GRID VALUES ARE MEASURED, NOT GUESSED, and the first version of this was
 * wrong in a way worth recording. It shipped `zScale {1, 2, 3}`, and at those
 * scales the target moves by a median of 0.0624 per bar at 1d and 0.0356 at 4h
 * (measured on the real positioning column, three symbols, pre-lockbox), which
 * is ABOVE the 0.1 band on about a third of bars. So every cell traded
 * constantly: 1.0 to 2.4 bars between rebalances across all twelve grid runs,
 * which is a continuously rebalanced book wearing a band's name.
 *
 * Worse, `band = 0` then won selection in 11 of 12 windows. That is not the
 * band being useless, it is a per-period Sharpe preferring tidy iid returns:
 * a constantly rebalanced book has them, while a wide band holds one position
 * across many bars (fine for a real book, which still earns the drift and pays
 * nothing to keep the position) and scores badly on a series that mostly
 * repeats itself.
 *
 * `zScale` now spans the range where `tanh` is nearly linear for this column
 * (its trailing z runs to about +/-3), which puts the median per-bar move at
 * 0.02 or below and makes the band a filter rather than a lag.
 */
export const EXPOSURE_BAND_VALUES = [0, 0.1, 0.25, 0.5] as const;
export const EXPOSURE_ZSCALE_VALUES = [3, 6, 12] as const;
export const EXPOSURE_SMOOTHING_VALUES = [0, 8, 32] as const;
export const EXPOSURE_GRID_CELL_COUNT =
  EXPOSURE_BAND_VALUES.length * EXPOSURE_ZSCALE_VALUES.length * EXPOSURE_SMOOTHING_VALUES.length;

/** The minimum out-of-sample length a window may have, the same floor the
 * discrete path enforces. */
export const MIN_TEST_BARS = 50;

/** The shortest training slice that lets the longest smoothing window warm up
 * inside the training data and still leave one full factor decay horizon to
 * estimate a Sharpe over. */
export const MIN_TRAIN_BARS =
  Math.max(...EXPOSURE_SMOOTHING_VALUES) + FACTOR_DECAY_HORIZON_BARS;

/**
 * The grid, band-major then zScale then smoothing. The order is fixed because
 * it sets the grid index, and therefore both the earliest-index tie-break in
 * `selectCellIndex` and the index adjacency `parameterPlateauScore` uses.
 */
export function expandExposureGrid(): Array<Record<string, number>> {
  const cells: Array<Record<string, number>> = [];
  for (const band of EXPOSURE_BAND_VALUES) {
    for (const zScale of EXPOSURE_ZSCALE_VALUES) {
      for (const smoothing of EXPOSURE_SMOOTHING_VALUES) {
        cells.push({ band, zScale, smoothing });
      }
    }
  }
  return cells;
}

/**
 * The grid handed to the simulator for one logical cell.
 *
 * `smoothing` is ALWAYS 0 (see the module header). `gross` is the universe size,
 * the same for every cell: summed `|held|` peaks at `N / gross`, so this makes
 * peak gross exposure exactly one unit, which is what `grossExposure` and the
 * header's "per unit of gross deployed" both claim.
 */
export function gridFor(
  params: Record<string, number>,
  opts: { gross: number; interval: string }
): ExposureGrid {
  return {
    band: params.band,
    zScale: params.zScale,
    smoothing: 0,
    gross: opts.gross,
    interval: opts.interval,
  };
}

/**
 * The rank grid: which cross-sectional scheme, then the book-level band
 * expressed as a fraction of that scheme's own largest single-symbol weight.
 *
 * `topBottom` k=1, `topBottom` k=2 and `linearRank` do not share a native
 * weight scale (see `maxRankWeight`), so the grid varies the FRACTION of a
 * scheme's own max weight rather than an absolute band. `bandFraction: 0` is
 * the internal control, same reasoning as `EXPOSURE_BAND_VALUES[0]`: rebalance
 * every bar the ranking changes, with no gate at all.
 */
export const RANK_SCHEMES = [
  { scheme: 'topBottom', legs: 1 },
  { scheme: 'topBottom', legs: 2 },
  { scheme: 'linearRank', legs: 0 },
] as const;
export const RANK_BAND_FRACTIONS = [0, 0.25, 0.5] as const;
export const RANK_GRID_CELL_COUNT = RANK_SCHEMES.length * RANK_BAND_FRACTIONS.length;

/**
 * The pre-registration fixes `--trials 54` for every rank run (nine grid
 * cells x six pre-registered runs), not the nine-cell grid size, so the
 * deflated-Sharpe trials gate stays as hard as it was pre-registered even
 * when a run tests fewer than six factors.
 */
export const RANK_PREREGISTERED_TRIALS = 54;

/**
 * The rank grid, scheme-major then band fraction. The order is fixed for the
 * same reason `expandExposureGrid`'s is: it sets the grid index.
 *
 * `schemeIndex` (not the scheme string) is the param, so every logical cell
 * stays a flat `Record<string, number>` like the tanh grid's cells.
 */
export function expandRankGrid(): Array<Record<string, number>> {
  const cells: Array<Record<string, number>> = [];
  for (let schemeIndex = 0; schemeIndex < RANK_SCHEMES.length; schemeIndex++) {
    const { legs } = RANK_SCHEMES[schemeIndex];
    for (const bandFraction of RANK_BAND_FRACTIONS) {
      cells.push({ schemeIndex, legs, bandFraction });
    }
  }
  return cells;
}

/**
 * The grid handed to the simulator for one rank-mode logical cell.
 *
 * `band` is resolved from `bandFraction * maxRankWeight(...)`: an absolute
 * band tuned for `tanh`'s continuous target (up to +/-1) would either never
 * gate a `topBottom` book (whose largest weight is 1/(2*legs), well under 1)
 * or never let a `linearRank` book trade at all past a wide fraction, since
 * that scheme's largest weight is smaller still. Scaling by the scheme's own
 * max weight makes `bandFraction` comparable across all three schemes.
 *
 * `gross` is always 1: rank targets are unit-gross by construction (see
 * `crossSectionalTargets`), so `gridFor`'s per-cell `gross = universe size`
 * does not apply here. `smoothing` is always 0: the rank schemes rank a raw
 * cross-section bar by bar, so there is no smoothing warmup to pre-apply, and
 * `zScale` is unused by either rank scheme and pinned to 1 for a valid,
 * inert `ExposureGrid`.
 */
export function rankGridFor(
  params: Record<string, number>,
  opts: { interval: string; universeSize: number; factorSign: 1 | -1; minCrossSection: number }
): ExposureGrid {
  const { scheme } = RANK_SCHEMES[params.schemeIndex];
  const band = params.bandFraction * maxRankWeight(scheme, params.legs, opts.universeSize);
  return {
    band,
    zScale: 1,
    smoothing: 0,
    gross: 1,
    interval: opts.interval,
    scheme,
    legs: params.legs,
    factorSign: opts.factorSign,
    minCrossSection: opts.minCrossSection,
  };
}

/**
 * Apply one cell's trailing-mean smoothing ONCE, over the full trimmed series.
 *
 * `trailingMean` is the same function `simulateExposure` would have called, so
 * a pre-smoothed series handed to the simulator with `smoothing: 0` is
 * bit-for-bit what a single unsliced run would have produced. What changes is
 * WHERE the warmup lands, and that is the whole point.
 *
 * This is only half the fix, and the other half is easy to miss. Pre-smoothing
 * does not make the smoothed series finite any earlier: it needs `smoothing`
 * finite readings just as the simulator's own call would. So if the trim lands
 * exactly on the raw column's first reading, the smoothed column is still NaN
 * for another `smoothing - 1` bars, and a window starting there still sits out
 * its head. `smoothingWarmupBars` is the other half: the caller must trim past
 * `rawWarmup + smoothing - 1`, and the harness asserts the smoothed column is
 * finite at its first index so a future caller cannot silently skip it.
 */
export function preSmooth(
  symbols: readonly ExposureSymbolInput[],
  smoothing: number
): ExposureSymbolInput[] {
  if (smoothing <= 1) return symbols.map((s) => ({ ...s, z: [...s.z] }));
  return symbols.map((s) => ({ ...s, z: trailingMean(s.z, smoothing) }));
}

/**
 * The index of the first finite reading of a smoothed column.
 *
 * `rawWarmup` is where the unsmoothed column starts (the joint factor start);
 * a trailing mean over `smoothing` bars does not produce its first value until
 * `smoothing - 1` bars later. Zero for no smoothing.
 */
export function smoothingWarmupBars(rawWarmup: number, smoothing: number): number {
  return rawWarmup + Math.max(0, smoothing - 1);
}

/** The largest smoothing in the grid, which is what the run's trim must clear
 * so that every cell is tradeable from the first window bar. */
export function maxSmoothingWarmupBars(rawWarmup: number): number {
  return smoothingWarmupBars(rawWarmup, Math.max(...EXPOSURE_SMOOTHING_VALUES));
}

/** The first index at which every symbol in the universe has a finite reading,
 * or -1 when some symbol never produces one. The run is trimmed to this point:
 * a bar where one symbol has no reading is a bar the joint book cannot fully
 * act on, and leaving those bars in would inflate `barsTotal` while adding
 * nothing to `barsHeld`, which is the sample gate's numerator. */
export function jointFactorStart(columns: ReadonlyMap<string, readonly number[]>): number {
  let latest = 0;
  for (const values of columns.values()) {
    let first = -1;
    for (let i = 0; i < values.length; i++) {
      if (Number.isFinite(values[i])) {
        first = i;
        break;
      }
    }
    if (first < 0) return -1;
    if (first > latest) latest = first;
  }
  return latest;
}

/**
 * Restrict the universe to the timestamps every symbol carries, keeping the
 * order of the first symbol's grid.
 *
 * The perp series is not perfectly rectangular: SOLUSDT and XRPUSDT are each
 * missing 2022-03-01 and 2022-04-03, so a fixed index window puts them on a
 * different bar grid from the rest. `simulateExposure` refuses mismatched
 * lengths, and it should: the portfolio's held weights carry across a bar, so
 * a symbol with no bar there is not a zero return, it is an unknown one.
 *
 * Intersecting is the honest fix rather than forward-filling the hole. A
 * carried-forward return would invent a price move for the missing day, and
 * the exposure path has no fill model to justify one.
 */
export function alignToSharedGrid(
  symbols: readonly ExposureSymbolInput[]
): { symbols: ExposureSymbolInput[]; droppedBars: number } {
  if (symbols.length === 0) return { symbols: [], droppedBars: 0 };

  const key = symbols[0].timestamps;
  const perSymbol = symbols.map((s) => {
    const map = new Map<number, number>();
    for (let i = 0; i < s.timestamps.length; i++) map.set(s.timestamps[i], i);
    return map;
  });

  const keep: number[] = [];
  for (const t of key) {
    if (perSymbol.every((map) => map.has(t))) keep.push(t);
  }

  const out = symbols.map((s, si) => {
    const map = perSymbol[si];
    const idx = keep.map((t) => map.get(t) as number);
    return {
      symbol: s.symbol,
      timestamps: idx.map((i) => s.timestamps[i]),
      closes: idx.map((i) => s.closes[i]),
      fundingRates: idx.map((i) => s.fundingRates[i]),
      z: idx.map((i) => s.z[i]),
    };
  });

  return { symbols: out, droppedBars: key.length - keep.length };
}

/** Inclusive slice of one symbol's parallel arrays. */
export function sliceSymbolInput(
  input: ExposureSymbolInput,
  start: number,
  end: number
): ExposureSymbolInput {
  const from = Math.max(0, start);
  const to = Math.min(input.timestamps.length - 1, end);
  return {
    symbol: input.symbol,
    timestamps: input.timestamps.slice(from, to + 1),
    closes: input.closes.slice(from, to + 1),
    fundingRates: input.fundingRates.slice(from, to + 1),
    z: input.z.slice(from, to + 1),
  };
}

export interface ExposureWindowConfig {
  trainBars: number;
  testWindowBars: number;
  purgeGapBars: number;
  stepSizeBars: number;
  mode: 'rolling' | 'anchored';
  count: number;
  minIsSharpeBars: number;
  /** Bars trimmed from the head of the series before the geometry applies. */
  factorWarmupBars: number;
  /** Bars available to the walk-forward after that trim. */
  usableBars: number;
}

export interface ExposureWindowBounds {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

/**
 * The per-window in-sample floor, derived from the pooled out-of-sample gate it
 * has to predict so a protocol change propagates on its own.
 *
 * A per-window/pooled pair, and the header of the harness says so: this floor
 * is per window while `minBarsHeldFor` is pooled across selected windows, so
 * the two numbers are not the same threshold expressed twice.
 */
export function minIsSharpeBarsFor(interval: string, trainFraction: number): number {
  return Math.ceil(minBarsHeldFor(interval) * trainFraction);
}

/**
 * Window geometry over the TRIMMED series.
 *
 * `purgeGapBars` is 0, and that is a decision rather than an omission. The
 * discrete path needs a gap because the engine carries indicator state across
 * the boundary. This path carries exactly one piece of state, the held weight,
 * and `simulateExposure` re-initialises it flat on every call, so nothing
 * crosses in either direction. Returns do not overlap either: bar t earns
 * t -> t+1 and `testStart` is `trainEnd + 1`. The residual artefact is a
 * cold-start round trip bounded by the symbol count in turnover units, which
 * biases AGAINST the run; a gap cannot fix it, because the weight resets either
 * way, and would throw away real bars.
 *
 * `minTrainBars` defaults to `MIN_TRAIN_BARS`, the tanh grid's smoothing
 * warmup floor. Rank mode has no smoothing to warm up (see `rankGridFor`), so
 * its caller passes `FACTOR_DECAY_HORIZON_BARS` instead: enough training bars
 * to estimate one factor decay horizon of Sharpe, no more.
 */
export function resolveExposureWindowConfig(
  usableBars: number,
  interval: string,
  windows: { count: number; trainFraction: number; mode: 'rolling' | 'anchored' },
  factorWarmupBars = 0,
  minTrainBars: number = MIN_TRAIN_BARS
): ExposureWindowConfig & { bounds: ExposureWindowBounds[] } {
  if (usableBars < 2) {
    throw new Error(
      `insufficient data: usableBars=${usableBars} after trimming ${factorWarmupBars} bars; ` +
        'no bar can earn a forward return'
    );
  }

  const returnBars = usableBars - 1;
  const trainBars = Math.max(Math.floor(returnBars * windows.trainFraction), minTrainBars);
  const purgeGapBars = 0;
  const testWindowBars = Math.floor((returnBars - trainBars - purgeGapBars) / windows.count);

  if (testWindowBars < MIN_TEST_BARS) {
    throw new Error(
      `insufficient data: usableBars=${usableBars}, factorWarmupBars=${factorWarmupBars}, ` +
        `trainBars=${trainBars}, purgeGapBars=${purgeGapBars}, count=${windows.count} ` +
        `yields testWindowBars=${testWindowBars} (< ${MIN_TEST_BARS})`
    );
  }

  const pooledBars = windows.count * testWindowBars;
  const minBars = minBarsHeldFor(interval);
  if (pooledBars < minBars) {
    throw new Error(
      `insufficient data: ${windows.count} windows x ${testWindowBars} bars = ${pooledBars} ` +
        `out-of-sample bars, below the ${minBars}-bar sample gate for ${interval}; ` +
        'the run could not pass however good the factor is'
    );
  }

  const bounds = calculateWindows(returnBars, trainBars, testWindowBars, testWindowBars, {
    purgeGapBars,
    mode: windows.mode,
    rollingTrainBars: trainBars,
  });

  return {
    trainBars,
    testWindowBars,
    purgeGapBars,
    stepSizeBars: testWindowBars,
    mode: windows.mode,
    count: bounds.length,
    minIsSharpeBars: minIsSharpeBarsFor(interval, windows.trainFraction),
    factorWarmupBars,
    usableBars,
    bounds,
  };
}

export interface ExposureCellSummary {
  params: Record<string, number>;
  /** Finite net returns in the in-sample run. */
  bars: number;
  /** Bars carrying non-zero exposure, the sample gate's unit. */
  barsHeld: number;
  sharpe: number;
  meanReturnPercent: number;
  /** Sample standard deviation of the finite returns. Zero means the Sharpe
   * below is the library's placeholder, not a measurement. */
  returnSd: number;
  turnover: number;
}

/** Reduce one in-sample run to the numbers selection reads. */
export function summarizeCell(params: Record<string, number>, result: ExposureResult): ExposureCellSummary {
  const finite = result.netReturns.filter((v) => Number.isFinite(v));
  const barsHeld = result.grossExposure.filter((g) => g > 0).length;
  const turnover = result.turnover.reduce((a, b) => a + b, 0);
  const mean = finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
  const variance =
    finite.length > 1
      ? finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (finite.length - 1)
      : 0;
  return {
    params,
    bars: finite.length,
    barsHeld,
    sharpe: perPeriodSharpe(finite),
    meanReturnPercent: mean * 100,
    returnSd: Math.sqrt(variance),
    turnover,
  };
}

/** Which in-sample number ranks the grid. Default `'sharpe'` is
 * byte-identical to before this parameter existed; `'meanReturn'` ranks on
 * `meanReturnPercent` instead, for a grid (rank mode) where a highest-Sharpe
 * cell can be a thin, barely-held one that a mean-return selection would not
 * pick. */
export type SelectMetric = 'sharpe' | 'meanReturn';

/**
 * Highest in-sample metric among eligible cells; the earliest grid index wins
 * ties; -1 when nothing qualifies.
 *
 * Eligibility is stricter than the bars floor alone, and is the SAME for both
 * metrics. `perPeriodSharpe` returns 0 rather than NaN for a series with
 * fewer than two observations or zero standard deviation, so ranking raw on
 * that value would let a degenerate cell outrank genuinely losing ones. A
 * mean return has no such placeholder, but a degenerate cell (one finite
 * return, or a constant series) is not a measurement under either metric, so
 * the same floors gate both: a cell needs at least two finite returns AND a
 * non-zero sample spread.
 */
export function selectCellIndex(
  cells: readonly ExposureCellSummary[],
  minIsSharpeBars: number,
  metric: SelectMetric = 'sharpe'
): number {
  let bestIndex = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.barsHeld < minIsSharpeBars) continue;
    if (cell.bars < 2) continue;
    if (!(cell.returnSd > 0)) continue;
    const value = metric === 'meanReturn' ? cell.meanReturnPercent : cell.sharpe;
    if (value > bestValue) {
      bestValue = value;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export interface ExposureWindowRun {
  index: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  selectedParams: Record<string, number> | null;
  skippedReason: string | null;
  isCells: ExposureCellSummary[];
  /** The selected cell's out-of-sample run at nominal cost. */
  oos: ExposureCellRun | null;
  /** The same, with the stress multipliers applied. */
  oosStressed: ExposureCellRun | null;
}

export interface ExposureWalkForwardInput {
  /** The universe, already trimmed to the joint first finite reading. */
  symbols: readonly ExposureSymbolInput[];
  interval: string;
  windows: { count: number; trainFraction: number; mode: 'rolling' | 'anchored' };
  stress: { feeMultiplier: number; slippageMultiplier: number };
  /** Fee schedule every simulateExposure call in this run prices under
   * (nominal and stressed alike). Default: DEFAULT_FEE_PROFILE ('standard'),
   * byte-identical to before this field existed. */
  feeProfile?: FeeProfileName;
  /** `'exposure'` (default) runs the tanh band/zScale/smoothing grid,
   * byte-identical to before this field existed. `'rank'` runs the
   * cross-sectional grid (`expandRankGrid`) instead: unit gross, no
   * smoothing warmup, book-level rebalancing. */
  mode?: 'exposure' | 'rank';
  /** Sign under which a high reading is long. Rank mode only; forwarded to
   * `rankGridFor`. Default 1. */
  factorSign?: 1 | -1;
  /** Minimum finite cross-section readings to form a rank target. Rank mode
   * only; forwarded to `rankGridFor`. Default 5. */
  minCrossSection?: number;
  /** Which in-sample number `selectCellIndex` ranks on. Default `'sharpe'`. */
  selectMetric?: SelectMetric;
  /** 'maker' or 'taker' fill assumption, forwarded to every simulateExposure
   * call (nominal and stressed alike). Default 'taker'. */
  fill?: ExposureOptions['fill'];
  onWindow?: (info: { index: number; total: number; ms: number }) => void;
}

export interface ExposureWalkForwardResult {
  windowConfig: ExposureWindowConfig & { bounds: ExposureWindowBounds[] };
  windows: ExposureWindowRun[];
  /** One entry per grid cell, each run over the concatenated out-of-sample span.
   * NOT per window: `parameterPlateauScore`'s best entry is a `find` on params,
   * so duplicate rows per cell can make the plateau denominator a lower-metric
   * duplicate, and the trials variance should describe the grid rather than
   * carry window-to-window noise. */
  allCells: ExposureCellRun[];
}

export function runExposureWalkForward(input: ExposureWalkForwardInput): ExposureWalkForwardResult {
  const { symbols, interval } = input;
  if (symbols.length === 0) throw new Error('runExposureWalkForward: empty universe');

  const mode = input.mode ?? 'exposure';
  const isRank = mode === 'rank';
  const usableBars = symbols[0].timestamps.length;
  const gross = symbols.length;
  const gridCells = isRank ? expandRankGrid() : expandExposureGrid();
  const windowConfig = resolveExposureWindowConfig(
    usableBars,
    interval,
    input.windows,
    0,
    isRank ? FACTOR_DECAY_HORIZON_BARS : MIN_TRAIN_BARS
  );

  // Rank mode has no per-cell smoothing to warm up (see `rankGridFor`), so a
  // slice is handed to the simulator as-is rather than through `preSmooth`.
  const smoothFor = (slice: readonly ExposureSymbolInput[], smoothing: number): ExposureSymbolInput[] =>
    isRank ? slice.map((s) => ({ ...s, z: [...s.z] })) : preSmooth(slice, smoothing);
  const gridForCell = (params: Record<string, number>): ExposureGrid =>
    isRank
      ? rankGridFor(params, {
          interval,
          universeSize: symbols.length,
          factorSign: input.factorSign ?? 1,
          minCrossSection: input.minCrossSection ?? 5,
        })
      : gridFor(params, { gross, interval });
  const selectMetric: SelectMetric = input.selectMetric ?? 'sharpe';

  const nominalOptions: ExposureOptions = { feeProfile: input.feeProfile, fill: input.fill };
  const stressOptions: ExposureOptions = {
    feeMultiplier: input.stress.feeMultiplier,
    slippageMultiplier: input.stress.slippageMultiplier,
    feeProfile: input.feeProfile,
    fill: input.fill,
  };

  const windows: ExposureWindowRun[] = [];
  for (let index = 0; index < windowConfig.bounds.length; index++) {
    const startedAt = Date.now();
    const bound = windowConfig.bounds[index];

    const trainSymbols = symbols.map((s) => sliceSymbolInput(s, bound.trainStart, bound.trainEnd));
    const testSymbols = symbols.map((s) => sliceSymbolInput(s, bound.testStart, bound.testEnd));

    const isCells: ExposureCellSummary[] = [];
    const isRuns = new Map<number, ExposureResult>();
    for (let cellIndex = 0; cellIndex < gridCells.length; cellIndex++) {
      const params = gridCells[cellIndex];
      const smoothed = smoothFor(trainSymbols, params.smoothing);
      const grid = gridForCell(params);
      const result = simulateExposure(smoothed, grid, nominalOptions);
      isRuns.set(cellIndex, result);
      isCells.push(summarizeCell(params, result));
    }

    const selectedIndex = selectCellIndex(isCells, windowConfig.minIsSharpeBars, selectMetric);
    let selectedParams: Record<string, number> | null = null;
    let oos: ExposureCellRun | null = null;
    let oosStressed: ExposureCellRun | null = null;

    if (selectedIndex >= 0) {
      selectedParams = gridCells[selectedIndex];
      const smoothedTest = smoothFor(testSymbols, selectedParams.smoothing);
      const grid = gridForCell(selectedParams);
      oos = {
        window: index,
        params: selectedParams,
        symbols: smoothedTest,
        grid,
        options: nominalOptions,
        result: simulateExposure(smoothedTest, grid, nominalOptions),
      };
      oosStressed = {
        window: index,
        params: selectedParams,
        symbols: smoothedTest,
        grid,
        options: stressOptions,
        result: simulateExposure(smoothedTest, grid, stressOptions),
      };
    }

    windows.push({
      index,
      trainStart: bound.trainStart,
      trainEnd: bound.trainEnd,
      testStart: bound.testStart,
      testEnd: bound.testEnd,
      selectedParams,
      skippedReason:
        selectedIndex >= 0
          ? null
          : `no cell reached ${windowConfig.minIsSharpeBars} in-sample bars held`,
      isCells,
      oos,
      oosStressed,
    });

    input.onWindow?.({ index, total: windowConfig.bounds.length, ms: Date.now() - startedAt });
  }

  // One run per grid cell over the whole contiguous out-of-sample span.
  const oosStart = windowConfig.bounds[0]?.testStart ?? 0;
  const oosEnd = windowConfig.bounds[windowConfig.bounds.length - 1]?.testEnd ?? 0;
  const allCells: ExposureCellRun[] = [];
  if (windowConfig.bounds.length > 0) {
    const oosSymbols = symbols.map((s) => sliceSymbolInput(s, oosStart, oosEnd));
    for (const params of gridCells) {
      const smoothed = smoothFor(oosSymbols, params.smoothing);
      const grid = gridForCell(params);
      allCells.push({
        window: -1,
        params,
        symbols: smoothed,
        grid,
        options: nominalOptions,
        result: simulateExposure(smoothed, grid, nominalOptions),
      });
    }
  }

  return { windowConfig, windows, allCells };
}

/** Only used by `exposure-harness.ts` to assert the spot and perp grids agree. */
export function assertSharedGrid(a: readonly number[], b: readonly number[], label: string): void {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      throw new Error(
        `${label}: grids diverge at index ${i} (${new Date(a[i]).toISOString()} vs ` +
          `${new Date(b[i]).toISOString()}); the exposure path needs one shared bar grid`
      );
    }
  }
  if (a.length !== b.length) {
    throw new Error(`${label}: grids differ in length (${a.length} vs ${b.length})`);
  }
}

/** Re-exported so the harness and the callers cannot disagree about the shape. */
export type { OHLCV };
