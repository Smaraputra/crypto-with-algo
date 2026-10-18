import { writeFileSync } from 'fs';
import type { CandleRow } from './dataset-format';
import { loadCandles, loadManifest, verifyManifest } from './load-dataset';
import {
  NV1_C2,
  NV1_SYMBOLS,
  WEEK_MS,
  computeTurnover,
  filterEligibleCoins,
  prepareDataset,
  ridgeFit,
  ridgePredict,
  walkForward,
  zscoreAcross,
  type PreparedDataset,
  type WalkForwardWeekResult,
} from './nv1-c2';
import { coinDailySeries, computeDailyValueAreas } from './nv1-c3';
import { NV1_SEGMENTS, buildTrades, quantile7, type Trade } from './nv1-core';
import {
  initialEState,
  stepEProcess,
  type EProcessState,
} from '../../src/lib/signals/lab/e-process';
import { bookWeights, centredRanks } from '../../src/lib/stats/rank-ic';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';

export const CROSSING_THRESHOLD = 400;
export const LOG_CROSSING_THRESHOLD = Math.log(CROSSING_THRESHOLD);

export const POWER_HORIZON = {
  c2: 104,
  c3: 730,
} as const;

export const BARS_PER_YEAR = {
  c2: 52,
  c3: 365,
} as const;

/**
 * Power simulation seeds: base 20261400 with fixed offsets per case.
 * Documented offsets:
 * - C2 measured:  +0  (20261400)
 * - C2 sharpe1:   +1  (20261401)
 * - C2 sharpe2:   +2  (20261402)
 * - C2 sharpe2_5: +3  (20261403)
 * - C3 measured:  +10 (20261410)
 * - C3 sharpe1:   +11 (20261411)
 * - C3 sharpe2:   +12 (20261412)
 * - C3 sharpe2_5: +13 (20261413)
 */
export const POWER_SEEDS = {
  c2: {
    measured: 20261400,
    sharpe1: 20261401,
    sharpe2: 20261402,
    sharpe2_5: 20261403,
  },
  c3: {
    measured: 20261410,
    sharpe1: 20261411,
    sharpe2: 20261412,
    sharpe2_5: 20261413,
  },
} as const;

/**
 * Real-returns null simulation seeds: base 20261500 per hypothesis.
 */
export const NULL_SEEDS = {
  c2: 20261500,
  c3: 20261500,
} as const;

export interface SeriesStats {
  bars: number;
  mean: number;
  sd: number;
  sharpe: number;
  sharePositive: number;
  skewness: number;
  kurtosis: number;
}

export interface PowerCaseResult {
  crossingShare: number;
  medianCrossingBar: number | null;
}

export interface HypothesisPower {
  measured: PowerCaseResult;
  sharpe1: PowerCaseResult;
  sharpe2: PowerCaseResult;
  sharpe2_5: PowerCaseResult;
}

export interface C2SeriesItem {
  M: number;
  R: number;
  cash: boolean;
  incomplete: boolean;
  turnover: number;
}

export interface C3SeriesItem {
  t: number;
  R: number;
  trades: number;
}

export interface HypothesisResult<TSeriesItem> {
  series: TSeriesItem[];
  stats: {
    B: SeriesStats;
    C: SeriesStats;
    BC: SeriesStats;
  };
  scale: number;
  clipShare: number;
  power: HypothesisPower;
  nullCrossings: number;
  nullMaxLogE: number;
}

export interface LabV2PreviewOutput {
  datasetHash: string;
  generatedAt: string;
  c2: HypothesisResult<C2SeriesItem>;
  c3: HypothesisResult<C3SeriesItem>;
}

export function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Rounds a positive number UP (ceiling) to 2 significant figures.
 * Examples:
 * - 0.0213 -> 0.022
 * - 0.1 -> 0.1
 * - 0.00456 -> 0.0046
 */
export function roundUpTo2SigFigs(x: number): number {
  if (x <= 0 || !Number.isFinite(x)) {
    return x;
  }
  const exponent = Math.floor(Math.log10(x));
  const unit = Math.pow(10, exponent - 1);
  const scaled = x / unit;
  const roundedScaled = Math.ceil(Number(scaled.toFixed(10)));
  const result = roundedScaled * unit;
  return Number(result.toPrecision(12));
}

/**
 * Computes descriptive stats on a series of returns:
 * - bars count
 * - mean R
 * - sample SD (n - 1)
 * - annualised Sharpe: mean / SD * sqrt(barsPerYear)
 * - share of positive bars (R > 0)
 * - Pearson skewness: m3 / (m2^1.5)
 * - Pearson kurtosis: m4 / (m2^2) (raw fourth moment, normal = 3)
 */
export function computeStats(returns: number[], barsPerYear: number): SeriesStats {
  const n = returns.length;
  if (n === 0) {
    return {
      bars: 0,
      mean: Number.NaN,
      sd: Number.NaN,
      sharpe: Number.NaN,
      sharePositive: Number.NaN,
      skewness: Number.NaN,
      kurtosis: Number.NaN,
    };
  }

  let sum = 0;
  let positiveCount = 0;
  for (let i = 0; i < n; i++) {
    sum += returns[i];
    if (returns[i] > 0) {
      positiveCount++;
    }
  }
  const mean = sum / n;
  const sharePositive = positiveCount / n;

  if (n < 2) {
    return {
      bars: n,
      mean,
      sd: Number.NaN,
      sharpe: Number.NaN,
      sharePositive,
      skewness: Number.NaN,
      kurtosis: Number.NaN,
    };
  }

  let sumSq = 0;
  let sumCube = 0;
  let sumQuad = 0;
  for (let i = 0; i < n; i++) {
    const d = returns[i] - mean;
    const d2 = d * d;
    sumSq += d2;
    sumCube += d2 * d;
    sumQuad += d2 * d2;
  }

  const sampleVariance = sumSq / (n - 1);
  const sampleSd = Math.sqrt(sampleVariance);
  const sharpe = sampleSd > 0 ? (mean / sampleSd) * Math.sqrt(barsPerYear) : Number.NaN;

  const m2 = sumSq / n;
  const skewness = m2 > 0 ? sumCube / n / Math.pow(m2, 1.5) : Number.NaN;
  const kurtosis = m2 > 0 ? sumQuad / n / Math.pow(m2, 2) : Number.NaN;

  return {
    bars: n,
    mean,
    sd: sampleSd,
    sharpe,
    sharePositive,
    skewness,
    kurtosis,
  };
}

export function sampleSd(values: number[]): number {
  const n = values.length;
  if (n < 2) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / (n - 1));
}

/**
 * Groups trades across all coins by openT.
 * R for that day is mean(netPct) / 100 over trades opened that day.
 * Days with no trades are not included.
 */
export function groupTradesByDay(trades: Trade[]): {
  bars: C3SeriesItem[];
  tradesByDay: Map<number, Trade[]>;
} {
  const tradesByDay = new Map<number, Trade[]>();
  for (const tr of trades) {
    let list = tradesByDay.get(tr.openT);
    if (!list) {
      list = [];
      tradesByDay.set(tr.openT, list);
    }
    list.push(tr);
  }

  const sortedDays = Array.from(tradesByDay.keys()).sort((a, b) => a - b);
  const bars: C3SeriesItem[] = [];

  for (const t of sortedDays) {
    const dayTrades = tradesByDay.get(t)!;
    let sumNetPct = 0;
    for (const tr of dayTrades) {
      sumNetPct += tr.netPct;
    }
    const meanNetPct = sumNetPct / dayTrades.length;
    bars.push({
      t,
      R: meanNetPct / 100,
      trades: dayTrades.length,
    });
  }

  return { bars, tradesByDay };
}

/**
 * Steps the forward lab e-process over a given sequence of X values with b = 0.
 * Reports whether and at which 1-indexed bar it reached logE >= log(threshold).
 */
export function runEProcessOnXSeries(
  xSeries: number[],
  b: number = 0,
  thresholdLog: number = LOG_CROSSING_THRESHOLD
): {
  crossed: boolean;
  crossedBar: number | null;
  finalState: EProcessState;
  maxLogE: number;
} {
  let state = initialEState();
  let crossed = false;
  let crossedBar: number | null = null;
  let maxLogE = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < xSeries.length; i++) {
    const x = xSeries[i];
    const step = stepEProcess(state, {
      barTime: i + 1,
      x,
      b,
    });
    state = step.state;
    if (state.logE > maxLogE) {
      maxLogE = state.logE;
    }
    if (!crossed && state.logE >= thresholdLog) {
      crossed = true;
      crossedBar = i + 1;
    }
  }

  return { crossed, crossedBar, finalState: state, maxLogE };
}

/**
 * Power Monte Carlo simulation:
 * 300 runs, each drawing bars i.i.d. with replacement from pool.
 * Each run checks if logE reaches log(400) at any bar up to horizon.
 */
export function runPowerCase(
  xPool: number[],
  horizon: number,
  runs: number,
  seed: number,
  thresholdLog: number = LOG_CROSSING_THRESHOLD
): PowerCaseResult {
  const random = createSeededRandom(seed);
  const nPool = xPool.length;
  let crossedCount = 0;
  const crossingBars: number[] = [];

  for (let r = 0; r < runs; r++) {
    let state = initialEState();
    let crossed = false;
    let crossedBar: number | null = null;

    for (let bar = 1; bar <= horizon; bar++) {
      const idx = Math.floor(random() * nPool);
      const x = xPool[idx];
      const step = stepEProcess(state, { barTime: bar, x, b: 0 });
      state = step.state;
      if (!crossed && state.logE >= thresholdLog) {
        crossed = true;
        crossedBar = bar;
      }
    }

    if (crossed && crossedBar !== null) {
      crossedCount++;
      crossingBars.push(crossedBar);
    }
  }

  const crossingShare = runs > 0 ? crossedCount / runs : 0;
  let medianCrossingBar: number | null = null;
  if (crossingBars.length > 0) {
    crossingBars.sort((a, b) => a - b);
    medianCrossingBar = quantile7(crossingBars, 0.5);
  }

  return { crossingShare, medianCrossingBar };
}

/**
 * Power analysis across measured and Sharpe shifts (1.0, 2.0, 2.5).
 */
export function runHypothesisPower(
  xSeries: number[],
  horizon: number,
  barsPerYear: number,
  seeds: {
    measured: number;
    sharpe1: number;
    sharpe2: number;
    sharpe2_5: number;
  },
  runs: number = 300
): HypothesisPower {
  const measured = runPowerCase(xSeries, horizon, runs, seeds.measured);

  // Demeaned X series
  const n = xSeries.length;
  let sumX = 0;
  for (let i = 0; i < n; i++) sumX += xSeries[i];
  const meanX = sumX / n;
  const sdX = sampleSd(xSeries);

  const demeaned = xSeries.map((x) => x - meanX);

  const makeShifted = (targetSharpe: number): number[] => {
    const shift = (targetSharpe * sdX) / Math.sqrt(barsPerYear);
    return demeaned.map((dx) => clip(dx + shift, -1, 1));
  };

  const poolS1 = makeShifted(1.0);
  const poolS2 = makeShifted(2.0);
  const poolS25 = makeShifted(2.5);

  const sharpe1 = runPowerCase(poolS1, horizon, runs, seeds.sharpe1);
  const sharpe2 = runPowerCase(poolS2, horizon, runs, seeds.sharpe2);
  const sharpe2_5 = runPowerCase(poolS25, horizon, runs, seeds.sharpe2_5);

  return {
    measured,
    sharpe1,
    sharpe2,
    sharpe2_5,
  };
}

/**
 * Extracts coins held by the real C2 book in each test week.
 * Matches walkForward logic identically.
 */
export function extractC2HeldCoins(
  prepared: PreparedDataset,
  lookbackWeeks: number | 'all' = 260,
  k: number = 1
): Map<number, string[]> {
  const minCoins = NV1_C2.minCoins;
  const testStart = NV1_SEGMENTS.B.start;
  const testEnd = NV1_SEGMENTS.C.end - WEEK_MS;

  interface WeekPreprocessed {
    M: number;
    keptCoins: string[];
    zFeatures: Map<string, number[]>;
    trainingRows: Array<{ x: number[]; y: number }>;
  }

  const preprocessed = new Map<number, WeekPreprocessed>();

  for (const pw of prepared.weeks) {
    const M = pw.M;
    const keptCoins: string[] = [];
    const featRes1w: number[] = [];
    const featRes4w: number[] = [];
    const featVol4w: number[] = [];
    const featTbs1w: number[] = [];
    const featVtrend: number[] = [];

    for (const [sym, cd] of pw.coinData) {
      keptCoins.push(sym);
      featRes1w.push(cd.rawFeatures.res1w);
      featRes4w.push(cd.rawFeatures.res4w);
      featVol4w.push(cd.rawFeatures.vol4w);
      featTbs1w.push(cd.rawFeatures.tbs1w);
      featVtrend.push(cd.rawFeatures.vtrend);
    }

    if (keptCoins.length < minCoins) {
      preprocessed.set(M, {
        M,
        keptCoins,
        zFeatures: new Map(),
        trainingRows: [],
      });
      continue;
    }

    const zRes1w = zscoreAcross(featRes1w);
    const zRes4w = zscoreAcross(featRes4w);
    const zVol4w = zscoreAcross(featVol4w);
    const zTbs1w = zscoreAcross(featTbs1w);
    const zVtrend = zscoreAcross(featVtrend);

    const zFeatures = new Map<string, number[]>();
    for (let i = 0; i < keptCoins.length; i++) {
      zFeatures.set(keptCoins[i], [
        zRes1w[i],
        zRes4w[i],
        zVol4w[i],
        zTbs1w[i],
        zVtrend[i],
      ]);
    }

    const targetCoins: string[] = [];
    const targetValues: number[] = [];
    for (const sym of keptCoins) {
      const cd = pw.coinData.get(sym);
      if (cd && cd.target !== null && Number.isFinite(cd.target)) {
        targetCoins.push(sym);
        targetValues.push(cd.target);
      }
    }

    const trainingRows: Array<{ x: number[]; y: number }> = [];
    if (targetCoins.length >= minCoins) {
      const zTargets = zscoreAcross(targetValues);
      for (let i = 0; i < targetCoins.length; i++) {
        const sym = targetCoins[i];
        const feats = zFeatures.get(sym);
        if (feats) {
          trainingRows.push({ x: feats, y: zTargets[i] });
        }
      }
    }

    preprocessed.set(M, {
      M,
      keptCoins,
      zFeatures,
      trainingRows,
    });
  }

  const weeklyPredictions = new Map<number, Map<string, number>>();
  const weeklySigns = new Map<number, Map<string, number>>();

  for (const pw of prepared.weeks) {
    const M = pw.M;
    const pp = preprocessed.get(M);
    if (!pp || pp.keptCoins.length < minCoins) continue;

    const trainingWeeks: number[] = [];
    const lookbackMs = lookbackWeeks === 'all' ? Number.POSITIVE_INFINITY : lookbackWeeks * WEEK_MS;

    for (const pastWeek of prepared.weeks) {
      const W = pastWeek.M;
      if (W + NV1_C2.embargoWeeks * WEEK_MS <= M && W >= M - lookbackMs) {
        const pastPp = preprocessed.get(W);
        if (pastPp && pastPp.trainingRows.length >= minCoins) {
          trainingWeeks.push(W);
        }
      }
    }

    const pooledX: number[][] = [];
    const pooledY: number[] = [];
    for (const W of trainingWeeks) {
      const pastPp = preprocessed.get(W);
      if (pastPp) {
        for (const row of pastPp.trainingRows) {
          pooledX.push(row.x);
          pooledY.push(row.y);
        }
      }
    }

    if (pooledX.length < minCoins) continue;

    let model: ReturnType<typeof ridgeFit>;
    try {
      model = ridgeFit(pooledX, pooledY, NV1_C2.lambda);
    } catch {
      continue;
    }

    const preds = new Map<string, number>();
    const keptList: string[] = [];
    const predList: number[] = [];

    for (const sym of pp.keptCoins) {
      const feats = pp.zFeatures.get(sym);
      if (feats) {
        const p = ridgePredict(model, feats);
        preds.set(sym, p);
        keptList.push(sym);
        predList.push(p);
      }
    }

    weeklyPredictions.set(M, preds);

    const cRanks = centredRanks(predList);
    const signMap = new Map<string, number>();
    for (let i = 0; i < keptList.length; i++) {
      signMap.set(keptList[i], Math.sign(cRanks[i]));
    }
    weeklySigns.set(M, signMap);
  }

  const testWeeks = prepared.weeks.filter((pw) => pw.M >= testStart && pw.M <= testEnd);
  const heldCoinsMap = new Map<number, string[]>();

  for (const pw of testWeeks) {
    const M = pw.M;
    const preds = weeklyPredictions.get(M);
    const pp = preprocessed.get(M);

    if (!preds || !pp || pp.keptCoins.length < minCoins) {
      heldCoinsMap.set(M, []);
      continue;
    }

    const eligibleCoins = filterEligibleCoins(pp.keptCoins, weeklySigns, M, k);
    if (eligibleCoins.length < minCoins) {
      heldCoinsMap.set(M, []);
      continue;
    }

    const eligiblePreds = eligibleCoins.map((sym) => preds.get(sym)!);
    const weights = bookWeights(eligiblePreds);

    let hasLong = false;
    let hasShort = false;
    for (const w of weights) {
      if (w > 0) hasLong = true;
      if (w < 0) hasShort = true;
    }

    if (!hasLong || !hasShort) {
      heldCoinsMap.set(M, []);
      continue;
    }

    let returnsComplete = true;
    for (let i = 0; i < eligibleCoins.length; i++) {
      const sym = eligibleCoins[i];
      const rawRet = pw.coinData.get(sym)?.rawForwardReturn;
      if (rawRet === null || rawRet === undefined || !Number.isFinite(rawRet)) {
        returnsComplete = false;
        break;
      }
    }

    if (!returnsComplete) {
      heldCoinsMap.set(M, []);
      continue;
    }

    heldCoinsMap.set(M, eligibleCoins);
  }

  return heldCoinsMap;
}

/**
 * C2 real-returns null:
 * 1,000 runs on B+C weeks.
 * For each week, centred-rank weights from uniform random scores over the coins
 * that week's real book held.
 * Book return = sum(w * coins' raw forward returns).
 * Turnover charged against previous random book at 0.0007.
 */
export function runC2NullSimulation(
  weeks: WalkForwardWeekResult[],
  prepared: PreparedDataset,
  heldCoinsMap: Map<number, string[]>,
  scale: number,
  runs: number = 1000,
  seed: number = NULL_SEEDS.c2,
  thresholdLog: number = LOG_CROSSING_THRESHOLD
): { nullCrossings: number; nullMaxLogE: number } {
  const random = createSeededRandom(seed);
  let nullCrossings = 0;
  let nullMaxLogE = Number.NEGATIVE_INFINITY;

  for (let r = 0; r < runs; r++) {
    let prevWeights = new Map<string, number>();
    let state = initialEState();
    let runCrossed = false;

    for (const w of weeks) {
      const M = w.M;
      const heldCoins = heldCoinsMap.get(M) ?? [];

      let net: number;

      if (heldCoins.length === 0) {
        const turnover = computeTurnover(prevWeights, new Map());
        const cost = NV1_C2.costRate * turnover;
        net = -cost;
        prevWeights = new Map();
      } else {
        const randomScores = heldCoins.map(() => random());
        const weights = bookWeights(randomScores);
        const currentWeights = new Map<string, number>();
        let gross = 0;

        for (let i = 0; i < heldCoins.length; i++) {
          const sym = heldCoins[i];
          currentWeights.set(sym, weights[i]);
          const rawFwd = prepared.byM.get(M)?.coinData.get(sym)?.rawForwardReturn ?? 0;
          gross += weights[i] * rawFwd;
        }

        const turnover = computeTurnover(prevWeights, currentWeights);
        const cost = NV1_C2.costRate * turnover;
        net = gross - cost;
        prevWeights = currentWeights;
      }

      const x = clip(net / scale, -1, 1);
      const step = stepEProcess(state, { barTime: M, x, b: 0 });
      state = step.state;

      if (state.logE > nullMaxLogE) {
        nullMaxLogE = state.logE;
      }
      if (!runCrossed && state.logE >= thresholdLog) {
        runCrossed = true;
      }
    }

    if (runCrossed) {
      nullCrossings++;
    }
  }

  return { nullCrossings, nullMaxLogE };
}

/**
 * C3 real-returns null:
 * 1,000 runs on B+C daily bars.
 * For every real trade, a random side (+1 or -1, probability 1/2).
 * Net = randomSide * (grossPct / d) - 0.14.
 * Daily R = mean(net) / 100 over trades opened that day.
 */
export function runC3NullSimulation(
  bars: C3SeriesItem[],
  tradesByDay: Map<number, Trade[]>,
  scale: number,
  runs: number = 1000,
  seed: number = NULL_SEEDS.c3,
  thresholdLog: number = LOG_CROSSING_THRESHOLD
): { nullCrossings: number; nullMaxLogE: number } {
  const random = createSeededRandom(seed);
  let nullCrossings = 0;
  let nullMaxLogE = Number.NEGATIVE_INFINITY;

  for (let r = 0; r < runs; r++) {
    let state = initialEState();
    let runCrossed = false;

    for (const bar of bars) {
      const dayTrades = tradesByDay.get(bar.t) ?? [];
      let sumNetPct = 0;

      for (const tr of dayTrades) {
        const randomSide = random() < 0.5 ? 1 : -1;
        const rawReturnPct = tr.grossPct / tr.d;
        const netPct = randomSide * rawReturnPct - 0.14;
        sumNetPct += netPct;
      }

      const meanNetPct = dayTrades.length > 0 ? sumNetPct / dayTrades.length : 0;
      const R = meanNetPct / 100;
      const x = clip(R / scale, -1, 1);
      const step = stepEProcess(state, { barTime: bar.t, x, b: 0 });
      state = step.state;

      if (state.logE > nullMaxLogE) {
        nullMaxLogE = state.logE;
      }
      if (!runCrossed && state.logE >= thresholdLog) {
        runCrossed = true;
      }
    }

    if (runCrossed) {
      nullCrossings++;
    }
  }

  return { nullCrossings, nullMaxLogE };
}

export interface CliArgs {
  datasetDir: string;
  out: string;
}

export function parseArgs(argv: string[]): CliArgs {
  let datasetDir: string | null = null;
  let out: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dataset-dir') {
      datasetDir = argv[++i];
    } else if (arg === '--out') {
      out = argv[++i];
    }
  }

  if (!datasetDir) {
    throw new Error('--dataset-dir is required');
  }
  if (!out) {
    throw new Error('--out is required');
  }

  return { datasetDir, out };
}

export async function generateLabV2Preview(datasetDir: string): Promise<LabV2PreviewOutput> {
  const verify = await verifyManifest(datasetDir);
  if (!verify.ok) {
    throw new Error(`verifyManifest failed: ${verify.mismatches.join(', ')}`);
  }

  const manifest = loadManifest(datasetDir);
  const datasetHash = manifest.datasetHash;
  const generatedAt = new Date().toISOString();

  // 1. C2 Series
  const candlesBySymbolC2: Record<string, CandleRow[]> = {};
  for (const sym of NV1_SYMBOLS) {
    candlesBySymbolC2[sym] = loadCandles(datasetDir, sym, '1d', {
      allowHoldoutA: true,
      allowLockbox: false,
    }).rows;
  }

  const prepared = prepareDataset(candlesBySymbolC2);
  const weeks = walkForward(prepared, 260, 1);
  const heldCoinsMap = extractC2HeldCoins(prepared, 260, 1);

  const c2Series: C2SeriesItem[] = weeks.map((w) => ({
    M: w.M,
    R: w.net,
    cash: w.cash,
    incomplete: Boolean(w.incomplete),
    turnover: w.turnover ?? 0,
  }));

  const c2WeeksB = c2Series.filter((w) => w.M < NV1_SEGMENTS.C.start);
  const c2WeeksC = c2Series.filter((w) => w.M >= NV1_SEGMENTS.C.start);

  const statsC2B = computeStats(
    c2WeeksB.map((w) => w.R),
    BARS_PER_YEAR.c2
  );
  const statsC2C = computeStats(
    c2WeeksC.map((w) => w.R),
    BARS_PER_YEAR.c2
  );
  const statsC2BC = computeStats(
    c2Series.map((w) => w.R),
    BARS_PER_YEAR.c2
  );

  const c2Scale = roundUpTo2SigFigs(4 * statsC2BC.sd);
  const c2ClipCount = c2Series.filter((w) => Math.abs(w.R / c2Scale) > 1).length;
  const c2ClipShare = c2Series.length > 0 ? c2ClipCount / c2Series.length : 0;
  const c2XSeries = c2Series.map((w) => clip(w.R / c2Scale, -1, 1));

  const c2Power = runHypothesisPower(
    c2XSeries,
    POWER_HORIZON.c2,
    BARS_PER_YEAR.c2,
    POWER_SEEDS.c2
  );

  const c2Null = runC2NullSimulation(weeks, prepared, heldCoinsMap, c2Scale);

  // 2. C3 Series
  const allC3Trades: Trade[] = [];
  for (const sym of NV1_SYMBOLS) {
    const c15m = loadCandles(datasetDir, sym, '15m', {
      allowHoldoutA: false,
      allowLockbox: false,
    }).rows;

    const c1d = loadCandles(datasetDir, sym, '1d', {
      allowHoldoutA: false,
      allowLockbox: false,
    }).rows.filter((c) => c.t >= NV1_SEGMENTS.B.start && c.t < NV1_SEGMENTS.C.end);

    const coin = coinDailySeries(sym, computeDailyValueAreas(c15m), c1d, 0.25);
    const trades = buildTrades(coin, {
      k: 1,
      hold: 1,
      stepMs: 86_400_000,
      costPct: 0.14,
      from: NV1_SEGMENTS.B.start,
      to: NV1_SEGMENTS.C.end,
    });
    allC3Trades.push(...trades);
  }

  const { bars: c3Series, tradesByDay: c3TradesByDay } = groupTradesByDay(allC3Trades);

  const c3BarsB = c3Series.filter((b) => b.t < NV1_SEGMENTS.C.start);
  const c3BarsC = c3Series.filter((b) => b.t >= NV1_SEGMENTS.C.start);

  const statsC3B = computeStats(
    c3BarsB.map((b) => b.R),
    BARS_PER_YEAR.c3
  );
  const statsC3C = computeStats(
    c3BarsC.map((b) => b.R),
    BARS_PER_YEAR.c3
  );
  const statsC3BC = computeStats(
    c3Series.map((b) => b.R),
    BARS_PER_YEAR.c3
  );

  const c3Scale = roundUpTo2SigFigs(4 * statsC3BC.sd);
  const c3ClipCount = c3Series.filter((b) => Math.abs(b.R / c3Scale) > 1).length;
  const c3ClipShare = c3Series.length > 0 ? c3ClipCount / c3Series.length : 0;
  const c3XSeries = c3Series.map((b) => clip(b.R / c3Scale, -1, 1));

  const c3Power = runHypothesisPower(
    c3XSeries,
    POWER_HORIZON.c3,
    BARS_PER_YEAR.c3,
    POWER_SEEDS.c3
  );

  const c3Null = runC3NullSimulation(c3Series, c3TradesByDay, c3Scale);

  return {
    datasetHash,
    generatedAt,
    c2: {
      series: c2Series,
      stats: {
        B: statsC2B,
        C: statsC2C,
        BC: statsC2BC,
      },
      scale: c2Scale,
      clipShare: c2ClipShare,
      power: c2Power,
      nullCrossings: c2Null.nullCrossings,
      nullMaxLogE: c2Null.nullMaxLogE,
    },
    c3: {
      series: c3Series,
      stats: {
        B: statsC3B,
        C: statsC3C,
        BC: statsC3BC,
      },
      scale: c3Scale,
      clipShare: c3ClipShare,
      power: c3Power,
      nullCrossings: c3Null.nullCrossings,
      nullMaxLogE: c3Null.nullMaxLogE,
    },
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const preview = await generateLabV2Preview(args.datasetDir);
  writeFileSync(args.out, JSON.stringify(preview, null, 2), 'utf8');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
