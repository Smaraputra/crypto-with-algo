import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { CandleRow } from './dataset-format';
import { loadCandles, verifyManifest } from './load-dataset';
import { NV1_LISTING, NV1_SEGMENTS, firstEligible, quantile7 } from './nv1-core';
import { bookWeights, centredRanks, rankWeightedCorrelation } from '../../src/lib/stats/rank-ic';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';

export const NV1_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'ADAUSDT',
  'XRPUSDT',
  'LINKUSDT',
  'DOGEUSDT',
  'SOLUSDT',
  'DOTUSDT',
  'AVAXUSDT',
] as const;

export const C2_GUARD_MESSAGE =
  'nv1: C2 trains on segment A and runs only after the Round 1 lock is committed';

export const NV1_C2 = {
  ks: [0, 1, 2, 3],
  lookbackWeeks: [156, 260, 'all'] as const,
  lambda: 1.0,
  costRate: 0.0007,          // keep COST_RATE as an alias equal to this
  minCoins: 6,
  betaDays: 90,
  embargoWeeks: 1,
  placeboPermutations: 200,
  placeboSeedBase: 20261200,
  placeboQuantile: 0.9,
} as const;

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const COST_RATE = NV1_C2.costRate;

export function assertC2Allowed(scriptDir: string): void {
  const lockPath = join(scriptDir, 'next-version-v1.ts');
  if (!existsSync(lockPath)) {
    throw new Error(C2_GUARD_MESSAGE);
  }
}

export function isSymbolEligible(symbol: string, t: number): boolean {
  if (symbol in NV1_LISTING) {
    return t >= firstEligible(symbol);
  }
  return true;
}

export interface DailyReturn {
  t: number;
  r: number;
}

export type DailyReturnsResult = DailyReturn[] & {
  byTimestamp: Map<number, number>;
  get(t: number): number | undefined;
};

/**
 * Daily simple return r_d = close_d / close_{d-1} - 1 from spot 1d candles (UTC days).
 * A day missing for a coin makes that coin's returns spanning it missing.
 */
export function dailyReturns(candles: CandleRow[]): DailyReturnsResult {
  const sorted = [...candles].sort((a, b) => a.t - b.t);
  const result: DailyReturn[] = [];
  const map = new Map<number, number>();

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (curr.t - prev.t === DAY_MS && prev.c > 0) {
      const r = curr.c / prev.c - 1;
      result.push({ t: curr.t, r });
      map.set(curr.t, r);
    }
  }

  const enriched = result as DailyReturnsResult;
  enriched.byTimestamp = map;
  enriched.get = (t: number) => map.get(t);
  return enriched;
}

/**
 * Weekly rebalance timestamps at every Monday 00:00:00 UTC in [startMs, endMs].
 */
export function weeklyRebalances(startMs: number, endMs: number): number[] {
  const rebalances: number[] = [];
  if (startMs > endMs) return rebalances;

  const d = new Date(startMs);
  const day = d.getUTCDay(); // 0 is Sunday, 1 is Monday
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

  let firstMonday: number;
  if (day === 1 && dayStart >= startMs) {
    firstMonday = dayStart;
  } else if (day === 0) {
    firstMonday = dayStart + DAY_MS;
  } else if (day === 1) {
    firstMonday = dayStart + WEEK_MS;
  } else {
    firstMonday = dayStart + (8 - day) * DAY_MS;
  }

  let cur = firstMonday;
  while (cur <= endMs) {
    rebalances.push(cur);
    cur += WEEK_MS;
  }
  return rebalances;
}

export interface RawFeatures {
  beta: number;
  res1w: number;
  res4w: number;
  vol4w: number;
  tbs1w: number;
  vtrend: number;
}

export function areFeaturesFinite(f: RawFeatures): boolean {
  return (
    Number.isFinite(f.beta) &&
    Number.isFinite(f.res1w) &&
    Number.isFinite(f.res4w) &&
    Number.isFinite(f.vol4w) &&
    Number.isFinite(f.tbs1w) &&
    Number.isFinite(f.vtrend)
  );
}

/**
 * Compute raw features for one coin at rebalance M.
 * Information available: daily bars that closed before Monday M (through Sunday).
 */
export function featuresAt(
  symbol: string,
  M: number,
  coinCandlesOrMap: CandleRow[] | Map<number, CandleRow> | Record<string, CandleRow[]>,
  btcCandlesOrMap?: CandleRow[] | Map<number, CandleRow>
): RawFeatures {
  let coinMap: Map<number, CandleRow>;
  let btcMap: Map<number, CandleRow>;

  if (Array.isArray(coinCandlesOrMap)) {
    coinMap = new Map();
    for (const c of coinCandlesOrMap) coinMap.set(c.t, c);
    if (Array.isArray(btcCandlesOrMap)) {
      btcMap = new Map();
      for (const c of btcCandlesOrMap) btcMap.set(c.t, c);
    } else if (btcCandlesOrMap instanceof Map) {
      btcMap = btcCandlesOrMap;
    } else if (symbol === 'BTCUSDT') {
      btcMap = coinMap;
    } else {
      btcMap = new Map();
    }
  } else if (coinCandlesOrMap instanceof Map) {
    coinMap = coinCandlesOrMap;
    if (btcCandlesOrMap instanceof Map) {
      btcMap = btcCandlesOrMap;
    } else if (Array.isArray(btcCandlesOrMap)) {
      btcMap = new Map();
      for (const c of btcCandlesOrMap) btcMap.set(c.t, c);
    } else if (symbol === 'BTCUSDT') {
      btcMap = coinMap;
    } else {
      btcMap = new Map();
    }
  } else {
    // Record<string, CandleRow[]>
    const cArr = coinCandlesOrMap[symbol] ?? [];
    coinMap = new Map();
    for (const c of cArr) coinMap.set(c.t, c);
    const bArr = coinCandlesOrMap['BTCUSDT'] ?? (symbol === 'BTCUSDT' ? cArr : []);
    btcMap = new Map();
    for (const c of bArr) btcMap.set(c.t, c);
  }

  // 90 daily returns ending Sunday before M
  // Day k (0..89): open timestamp = M - (NV1_C2.betaDays - k) * DAY_MS
  const coinReturns = new Array<number>(NV1_C2.betaDays);
  const btcReturns = new Array<number>(NV1_C2.betaDays);

  let returnsValid = true;
  for (let k = 0; k < NV1_C2.betaDays; k++) {
    const tCurr = M - (NV1_C2.betaDays - k) * DAY_MS;
    const tPrev = tCurr - DAY_MS;

    const coinCurr = coinMap.get(tCurr);
    const coinPrev = coinMap.get(tPrev);
    if (!coinCurr || !coinPrev || coinPrev.c <= 0) {
      returnsValid = false;
      break;
    }
    coinReturns[k] = coinCurr.c / coinPrev.c - 1;

    const btcCurr = btcMap.get(tCurr);
    const btcPrev = btcMap.get(tPrev);
    if (!btcCurr || !btcPrev || btcPrev.c <= 0) {
      returnsValid = false;
      break;
    }
    btcReturns[k] = btcCurr.c / btcPrev.c - 1;
  }

  let beta = Number.NaN;
  let res1w = Number.NaN;
  let res4w = Number.NaN;

  if (symbol === 'BTCUSDT') {
    beta = 1.0;
    res1w = 0.0;
    res4w = 0.0;
  } else if (returnsValid) {
    let meanX = 0;
    let meanY = 0;
    for (let k = 0; k < NV1_C2.betaDays; k++) {
      meanX += btcReturns[k];
      meanY += coinReturns[k];
    }
    meanX /= NV1_C2.betaDays;
    meanY /= NV1_C2.betaDays;

    let cov = 0;
    let varX = 0;
    for (let k = 0; k < NV1_C2.betaDays; k++) {
      const dx = btcReturns[k] - meanX;
      const dy = coinReturns[k] - meanY;
      cov += dx * dy;
      varX += dx * dx;
    }

    if (varX > 1e-15 && Number.isFinite(cov)) {
      const slope = cov / varX;
      beta = Math.max(0.1, Math.min(3.0, slope));

      let sum1w = 0;
      for (let k = NV1_C2.betaDays - 7; k < NV1_C2.betaDays; k++) {
        sum1w += coinReturns[k] - beta * btcReturns[k];
      }
      res1w = sum1w;

      let sum4w = 0;
      for (let k = NV1_C2.betaDays - 28; k < NV1_C2.betaDays; k++) {
        sum4w += coinReturns[k] - beta * btcReturns[k];
      }
      res4w = sum4w;
    }
  }

  // vol4w: sample standard deviation (n - 1) of daily returns over the last 28 days (indices 62..89)
  let vol4w = Number.NaN;
  if (returnsValid) {
    let mean28 = 0;
    for (let k = NV1_C2.betaDays - 28; k < NV1_C2.betaDays; k++) {
      mean28 += coinReturns[k];
    }
    mean28 /= 28;

    let sumSq = 0;
    for (let k = NV1_C2.betaDays - 28; k < NV1_C2.betaDays; k++) {
      const d = coinReturns[k] - mean28;
      sumSq += d * d;
    }
    vol4w = Math.sqrt(sumSq / 27);
  }

  // tbs1w: taker-buy volume / volume over last 7 days, excluding days with zero volume from both sums
  let tbs1w = Number.NaN;
  let sumTbv = 0;
  let sumV = 0;
  let tbsDaysValid = true;
  for (let k = NV1_C2.betaDays - 7; k < NV1_C2.betaDays; k++) {
    const tCurr = M - (NV1_C2.betaDays - k) * DAY_MS;
    const c = coinMap.get(tCurr);
    if (!c) {
      tbsDaysValid = false;
      break;
    }
    if (c.v > 0) {
      if (c.tbv === null || c.tbv === undefined || !Number.isFinite(c.tbv)) {
        tbsDaysValid = false;
        break;
      }
      sumV += c.v;
      sumTbv += c.tbv;
    }
  }
  if (tbsDaysValid && sumV > 0) {
    tbs1w = sumTbv / sumV;
  }

  // vtrend: mean daily volume over last 28 days divided by mean over last 84 days
  let vtrend = Number.NaN;
  let sumV28 = 0;
  let sumV84 = 0;
  let vtrendValid = true;
  for (let k = NV1_C2.betaDays - 84; k < NV1_C2.betaDays; k++) {
    const tCurr = M - (NV1_C2.betaDays - k) * DAY_MS;
    const c = coinMap.get(tCurr);
    if (!c) {
      vtrendValid = false;
      break;
    }
    sumV84 += c.v;
    if (k >= NV1_C2.betaDays - 28) {
      sumV28 += c.v;
    }
  }
  if (vtrendValid) {
    const mean28 = sumV28 / 28;
    const mean84 = sumV84 / 84;
    if (mean84 > 0) {
      vtrend = mean28 / mean84;
    }
  }

  return { beta, res1w, res4w, vol4w, tbs1w, vtrend };
}

/**
 * z-scores values across coins (mean, sample sd n - 1).
 * If sample sd is zero or length < 2, sets all values to 0.
 */
export function zscoreAcross(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;

  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    sumSq += d * d;
  }
  const variance = sumSq / (n - 1);
  const sd = Math.sqrt(variance);

  if (!Number.isFinite(sd) || sd <= 1e-14) {
    return new Array(n).fill(0);
  }

  return values.map((v) => (v - mean) / sd);
}

export interface RidgeModel {
  intercept: number;
  slopes: number[];
}

/**
 * Solves an m x m linear system M * x = b via Gaussian elimination with partial pivoting.
 */
export function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M = A.map((row) => [...row]);
  const x = [...b];

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    let maxVal = Math.abs(M[i][i]);
    for (let r = i + 1; r < n; r++) {
      const val = Math.abs(M[r][i]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = r;
      }
    }

    if (maxVal < 1e-14) {
      throw new Error('Singular matrix in Gaussian elimination');
    }

    if (maxRow !== i) {
      const tmpRow = M[i];
      M[i] = M[maxRow];
      M[maxRow] = tmpRow;
      const tmpB = x[i];
      x[i] = x[maxRow];
      x[maxRow] = tmpB;
    }

    const pivot = M[i][i];
    for (let r = i + 1; r < n; r++) {
      const factor = M[r][i] / pivot;
      x[r] -= factor * x[i];
      for (let c = i; c < n; c++) {
        M[r][c] -= factor * M[i][c];
      }
    }
  }

  const sol = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = x[i];
    for (let c = i + 1; c < n; c++) {
      sum -= M[i][c] * sol[c];
    }
    sol[i] = sum / M[i][i];
  }
  return sol;
}

/**
 * Ridge regression with intercept on pooled rows: solve (X'X + lambda * I_slopes) beta = X'y.
 * Penalty is on slopes only (intercept is not penalised).
 * features: matrix of raw feature columns (without intercept). An intercept column is always added internally.
 */
export function ridgeFit(features: number[][], y: number[], lambda: number = NV1_C2.lambda): RidgeModel {
  const N = features.length;
  if (N === 0) {
    return { intercept: 0, slopes: [] };
  }

  const p = features[0].length;
  const m = p + 1;

  // Build normal equations
  const A = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const B = new Array<number>(m).fill(0);

  for (let i = 0; i < N; i++) {
    const feats = features[i];
    const yi = y[i];

    // Intercept (index 0)
    A[0][0] += 1;
    B[0] += yi;
    for (let j = 0; j < p; j++) {
      const fj = feats[j];
      A[0][j + 1] += fj;
      A[j + 1][0] += fj;
      B[j + 1] += fj * yi;
      for (let k = 0; k < p; k++) {
        A[j + 1][k + 1] += fj * feats[k];
      }
    }
  }

  // Regularize slopes only
  for (let j = 1; j < m; j++) {
    A[j][j] += lambda;
  }

  const beta = solveLinearSystem(A, B);
  return {
    intercept: beta[0],
    slopes: beta.slice(1),
  };
}

export function ridgePredict(model: RidgeModel, features: number[]): number;
export function ridgePredict(model: RidgeModel, features: number[][]): number[];
export function ridgePredict(
  model: RidgeModel,
  features: number[] | number[][]
): number | number[] {
  if (features.length === 0) return [];
  if (typeof features[0] === 'number') {
    const f = features as number[];
    let pred = model.intercept;
    for (let j = 0; j < model.slopes.length; j++) {
      pred += model.slopes[j] * (f[j] ?? 0);
    }
    return pred;
  }

  const mat = features as number[][];
  return mat.map((row) => {
    let pred = model.intercept;
    for (let j = 0; j < model.slopes.length; j++) {
      pred += model.slopes[j] * (row[j] ?? 0);
    }
    return pred;
  });
}

/**
 * Raw residual return target for week M to M + 7 days.
 * Sum over those 7 days of (r_coin - beta_M * r_BTC).
 * Returns null if any day of the target week is missing.
 */
export function targetAt(
  symbol: string,
  M: number,
  beta: number,
  coinCandlesOrMap: CandleRow[] | Map<number, CandleRow> | Record<string, CandleRow[]>,
  btcCandlesOrMap?: CandleRow[] | Map<number, CandleRow>
): number | null {
  if (symbol === 'BTCUSDT') {
    return 0.0;
  }

  let coinMap: Map<number, CandleRow>;
  let btcMap: Map<number, CandleRow>;

  if (Array.isArray(coinCandlesOrMap)) {
    coinMap = new Map();
    for (const c of coinCandlesOrMap) coinMap.set(c.t, c);
    if (Array.isArray(btcCandlesOrMap)) {
      btcMap = new Map();
      for (const c of btcCandlesOrMap) btcMap.set(c.t, c);
    } else if (btcCandlesOrMap instanceof Map) {
      btcMap = btcCandlesOrMap;
    } else {
      btcMap = new Map();
    }
  } else if (coinCandlesOrMap instanceof Map) {
    coinMap = coinCandlesOrMap;
    if (btcCandlesOrMap instanceof Map) {
      btcMap = btcCandlesOrMap;
    } else if (Array.isArray(btcCandlesOrMap)) {
      btcMap = new Map();
      for (const c of btcCandlesOrMap) btcMap.set(c.t, c);
    } else {
      btcMap = new Map();
    }
  } else {
    const cArr = coinCandlesOrMap[symbol] ?? [];
    coinMap = new Map();
    for (const c of cArr) coinMap.set(c.t, c);
    const bArr = coinCandlesOrMap['BTCUSDT'] ?? [];
    btcMap = new Map();
    for (const c of bArr) btcMap.set(c.t, c);
  }

  let sumRes = 0;
  for (let d = 0; d < 7; d++) {
    const tCurr = M + d * DAY_MS;
    const tPrev = tCurr - DAY_MS;

    const coinCurr = coinMap.get(tCurr);
    const coinPrev = coinMap.get(tPrev);
    if (!coinCurr || !coinPrev || coinPrev.c <= 0) {
      return null;
    }
    const rCoin = coinCurr.c / coinPrev.c - 1;

    const btcCurr = btcMap.get(tCurr);
    const btcPrev = btcMap.get(tPrev);
    if (!btcCurr || !btcPrev || btcPrev.c <= 0) {
      return null;
    }
    const rBtc = btcCurr.c / btcPrev.c - 1;

    sumRes += rCoin - beta * rBtc;
  }

  return sumRes;
}

export interface PreparedCoinWeek {
  symbol: string;
  rawFeatures: RawFeatures;
  target: number | null;
  rawForwardReturn: number | null;
}

export interface PreparedWeek {
  M: number;
  coinData: Map<string, PreparedCoinWeek>;
}

export interface DroppedCoinWeeks {
  training: number;
  B: number;
  C: number;
}

export interface PreparedDataset {
  weeks: PreparedWeek[];
  byM: Map<number, PreparedWeek>;
  symbols: string[];
  droppedCoinWeeks: DroppedCoinWeeks;
}

/**
 * Computes turnover between two weight maps over the union of all symbols.
 */
export function computeTurnover(
  prevWeights: Map<string, number>,
  currentWeights: Map<string, number>
): number {
  const allSymbols = new Set<string>([...prevWeights.keys(), ...currentWeights.keys()]);
  let turnover = 0;
  for (const sym of allSymbols) {
    const wPrev = prevWeights.get(sym) ?? 0;
    const wCurr = currentWeights.get(sym) ?? 0;
    turnover += Math.abs(wCurr - wPrev);
  }
  return turnover;
}

/**
 * Prepares weekly raw features, targets, and raw forward returns from 1d candle data.
 */
export function prepareDataset(candlesBySymbol: Record<string, CandleRow[]>): PreparedDataset {
  const symbols = Object.keys(candlesBySymbol);
  const candleMaps = new Map<string, Map<number, CandleRow>>();
  let minT = Number.POSITIVE_INFINITY;
  let maxT = Number.NEGATIVE_INFINITY;

  for (const s of symbols) {
    const map = new Map<number, CandleRow>();
    for (const c of candlesBySymbol[s]) {
      map.set(c.t, c);
      if (c.t < minT) minT = c.t;
      if (c.t > maxT) maxT = c.t;
    }
    candleMaps.set(s, map);
  }

  const btcMap = candleMaps.get('BTCUSDT') ?? new Map<number, CandleRow>();
  const rebalances = weeklyRebalances(minT + (NV1_C2.betaDays + 1) * DAY_MS, maxT);
  const weeks: PreparedWeek[] = [];
  const byM = new Map<number, PreparedWeek>();
  const droppedCoinWeeks: DroppedCoinWeeks = {
    training: 0,
    B: 0,
    C: 0,
  };

  for (const M of rebalances) {
    const coinData = new Map<string, PreparedCoinWeek>();

    for (const s of symbols) {
      if (!isSymbolEligible(s, M)) continue;

      const cMap = candleMaps.get(s);
      if (!cMap) continue;

      const raw = featuresAt(s, M, cMap, btcMap);
      if (!areFeaturesFinite(raw)) {
        if (M < NV1_SEGMENTS.B.start) {
          droppedCoinWeeks.training++;
        } else if (M < NV1_SEGMENTS.C.start) {
          droppedCoinWeeks.B++;
        } else if (M <= NV1_SEGMENTS.C.end) {
          droppedCoinWeeks.C++;
        }
        continue;
      }

      const tgt = targetAt(s, M, raw.beta, cMap, btcMap);

      // Raw forward return over M to M + 7 days
      // Close at Sunday before M is cMap.get(M - DAY_MS).c
      // Close at Sunday before M + 7 days is cMap.get(M + 6 * DAY_MS).c
      const c0 = cMap.get(M - DAY_MS);
      const c7 = cMap.get(M + 6 * DAY_MS);
      let rawFwd: number | null = null;
      if (c0 && c7 && c0.c > 0) {
        rawFwd = c7.c / c0.c - 1;
      }

      coinData.set(s, {
        symbol: s,
        rawFeatures: raw,
        target: tgt,
        rawForwardReturn: rawFwd,
      });
    }

    const pw: PreparedWeek = { M, coinData };
    weeks.push(pw);
    byM.set(M, pw);
  }

  return { weeks, byM, symbols, droppedCoinWeeks };
}

export interface WalkForwardWeekResult {
  M: number;
  ic: number;
  net: number;
  eligible: number;
  cash: boolean;
  incomplete?: boolean;
  turnover?: number;
}

export interface WalkForwardOptions {
  onTrainingWeeks?: (M: number, trainingWeeks: number[]) => void;
  testStart?: number;
  testEnd?: number;
  minCoins?: number;
}

/**
 * Filters coins by confirmation delay k:
 * A coin is eligible at M only if the sign of its centred rank (by prediction)
 * was the same at the last k rebalances (k = 0: always eligible).
 */
export function filterEligibleCoins(
  keptCoins: string[],
  weeklySigns: Map<number, Map<string, number>>,
  M: number,
  k: number
): string[] {
  if (k === 0) {
    return [...keptCoins];
  }
  const currentSigns = weeklySigns.get(M);
  if (!currentSigns) return [];

  const eligible: string[] = [];
  for (const sym of keptCoins) {
    const currentSign = currentSigns.get(sym);
    if (currentSign === undefined || currentSign === 0) continue;

    let confirmed = true;
    for (let step = 1; step <= k; step++) {
      const pastM = M - step * WEEK_MS;
      const pastSign = weeklySigns.get(pastM)?.get(sym);
      if (pastSign === undefined || pastSign !== currentSign) {
        confirmed = false;
        break;
      }
    }
    if (confirmed) {
      eligible.push(sym);
    }
  }
  return eligible;
}

/**
 * Executes the walk-forward simulation on prepared dataset or raw candles.
 */
export function walkForward(
  data: Record<string, CandleRow[]> | PreparedDataset,
  lookbackWeeks: number | 'all',
  k: number,
  opts?: WalkForwardOptions
): WalkForwardWeekResult[] {
  const prepared: PreparedDataset =
    'byM' in data ? (data as PreparedDataset) : prepareDataset(data as Record<string, CandleRow[]>);

  const testStart = opts?.testStart ?? NV1_SEGMENTS.B.start;
  const testEnd = opts?.testEnd ?? NV1_SEGMENTS.C.end - WEEK_MS;
  const minCoins = opts?.minCoins ?? NV1_C2.minCoins;

  // Pre-process weekly training rows and kept features for all weeks
  interface WeekPreprocessed {
    M: number;
    keptCoins: string[];
    zFeatures: Map<string, number[]>; // symbol -> [res1w, res4w, vol4w, tbs1w, vtrend]
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

    // Training rows if targets exist
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

  // Pre-calculate predictions and centred ranks for all weeks to enable confirmation delay
  const weeklyPredictions = new Map<number, Map<string, number>>();
  const weeklySigns = new Map<number, Map<string, number>>();

  for (const pw of prepared.weeks) {
    const M = pw.M;
    const pp = preprocessed.get(M);
    if (!pp || pp.keptCoins.length < minCoins) continue;

    // Collect training weeks
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

    if (opts?.onTrainingWeeks && M >= testStart && M <= testEnd) {
      opts.onTrainingWeeks(M, trainingWeeks);
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

    let model: RidgeModel;
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

  // Run walk-forward through test span
  const testWeeks = prepared.weeks.filter((pw) => pw.M >= testStart && pw.M <= testEnd);
  const results: WalkForwardWeekResult[] = [];
  let prevWeights = new Map<string, number>();

  for (const pw of testWeeks) {
    const M = pw.M;
    const preds = weeklyPredictions.get(M);
    const pp = preprocessed.get(M);

    if (!preds || !pp || pp.keptCoins.length < minCoins) {
      // Cash week
      const turnover = computeTurnover(prevWeights, new Map());
      const cost = NV1_C2.costRate * turnover;
      prevWeights = new Map();
      results.push({
        M,
        ic: Number.NaN,
        net: -cost,
        eligible: 0,
        cash: true,
        incomplete: false,
        turnover,
      });
      continue;
    }

    // Confirmation delay k
    const eligibleCoins = filterEligibleCoins(pp.keptCoins, weeklySigns, M, k);

    if (eligibleCoins.length < minCoins) {
      const turnover = computeTurnover(prevWeights, new Map());
      const cost = NV1_C2.costRate * turnover;
      prevWeights = new Map();
      results.push({
        M,
        ic: Number.NaN,
        net: -cost,
        eligible: eligibleCoins.length,
        cash: true,
        incomplete: false,
        turnover,
      });
      continue;
    }

    // Re-rank eligible coins
    const eligiblePreds = eligibleCoins.map((sym) => preds.get(sym)!);
    const weights = bookWeights(eligiblePreds);

    let hasLong = false;
    let hasShort = false;
    for (const w of weights) {
      if (w > 0) hasLong = true;
      if (w < 0) hasShort = true;
    }

    if (!hasLong || !hasShort) {
      const turnover = computeTurnover(prevWeights, new Map());
      const cost = NV1_C2.costRate * turnover;
      prevWeights = new Map();
      results.push({
        M,
        ic: Number.NaN,
        net: -cost,
        eligible: eligibleCoins.length,
        cash: true,
        incomplete: false,
        turnover,
      });
      continue;
    }

    // Gross return and check completeness
    let gross = 0;
    const eligibleRawReturns: number[] = [];
    let returnsComplete = true;

    for (let i = 0; i < eligibleCoins.length; i++) {
      const sym = eligibleCoins[i];
      const rawRet = pw.coinData.get(sym)?.rawForwardReturn;
      if (rawRet === null || rawRet === undefined || !Number.isFinite(rawRet)) {
        returnsComplete = false;
        break;
      }
      eligibleRawReturns.push(rawRet);
      gross += weights[i] * rawRet;
    }

    if (!returnsComplete) {
      const turnover = computeTurnover(prevWeights, new Map());
      const cost = NV1_C2.costRate * turnover;
      prevWeights = new Map();
      results.push({
        M,
        ic: Number.NaN,
        net: -cost,
        eligible: eligibleCoins.length,
        cash: false,
        incomplete: true,
        turnover,
      });
      continue;
    }

    const currentWeights = new Map<string, number>();
    for (let i = 0; i < eligibleCoins.length; i++) {
      currentWeights.set(eligibleCoins[i], weights[i]);
    }

    const turnover = computeTurnover(prevWeights, currentWeights);
    const cost = NV1_C2.costRate * turnover;
    const net = gross - cost;
    const ic = rankWeightedCorrelation(eligiblePreds, eligibleRawReturns);

    prevWeights = currentWeights;

    results.push({
      M,
      ic,
      net,
      eligible: eligibleCoins.length,
      cash: false,
      incomplete: false,
      turnover,
    });
  }

  return results;
}

export interface CellSummary {
  lookback: number | 'all';
  k: number;
  meanNetB: number;
  meanNetC: number;
  meanIcB: number;
  meanIcC: number;
  meanIcBC: number;
  weeksB: number;
  weeksC: number;
  cashWeeksB: number;
  cashWeeksC: number;
  incompleteWeeksB: number;
  incompleteWeeksC: number;
  turnoverB: number;
  turnoverC: number;
  placeboMeanIc: number;
  placeboP90Ic: number;
  survives: boolean;
}

export interface ScreenResult {
  cells: CellSummary[];
  survivor: CellSummary | null;
  nullPromotionRate: number;
  droppedCoinWeeks: DroppedCoinWeeks;
}

export interface PlaceboResultsInput {
  cellMeanIcs: Map<string, number[]> | Record<string, number[]>;
  nullPromotionRate: number;
}

function cellKey(lookback: number | 'all', k: number): string {
  return `${lookback}_${k}`;
}

function meanOfFinite(vals: number[]): number {
  const finite = vals.filter(Number.isFinite);
  if (finite.length === 0) return Number.NaN;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/**
 * Screens cells on development segments B and C against the placebo null.
 */
export function screenCells(
  results: Array<{
    lookback: number | 'all';
    k: number;
    weeks: WalkForwardWeekResult[];
  }>,
  placebo: PlaceboResultsInput,
  droppedCoinWeeks?: DroppedCoinWeeks
): ScreenResult {
  const cells: CellSummary[] = [];

  for (const res of results) {
    const key = cellKey(res.lookback, res.k);
    const placeboIcs =
      placebo.cellMeanIcs instanceof Map
        ? placebo.cellMeanIcs.get(key) ?? []
        : placebo.cellMeanIcs[key] ?? [];

    const weeksB = res.weeks.filter(
      (w) => w.M >= NV1_SEGMENTS.B.start && w.M < NV1_SEGMENTS.B.end
    );
    const weeksC = res.weeks.filter(
      (w) => w.M >= NV1_SEGMENTS.C.start && w.M + WEEK_MS <= NV1_SEGMENTS.C.end
    );
    const weeksBC = [...weeksB, ...weeksC];

    const meanNetB = meanOfFinite(weeksB.map((w) => w.net));
    const meanNetC = meanOfFinite(weeksC.map((w) => w.net));
    const meanIcB = meanOfFinite(weeksB.map((w) => w.ic));
    const meanIcC = meanOfFinite(weeksC.map((w) => w.ic));
    const meanIcBC = meanOfFinite(weeksBC.map((w) => w.ic));

    const cashWeeksB = weeksB.filter((w) => w.cash).length;
    const cashWeeksC = weeksC.filter((w) => w.cash).length;
    const incompleteWeeksB = weeksB.filter((w) => Boolean(w.incomplete)).length;
    const incompleteWeeksC = weeksC.filter((w) => Boolean(w.incomplete)).length;

    const turnoverB = meanOfFinite(weeksB.map((w) => w.turnover ?? 0));
    const turnoverC = meanOfFinite(weeksC.map((w) => w.turnover ?? 0));

    const finitePlaceboIcs = placeboIcs.filter(Number.isFinite);
    const placeboMeanIc = meanOfFinite(placeboIcs);
    const placeboP90Ic =
      finitePlaceboIcs.length > 0
        ? quantile7(finitePlaceboIcs, NV1_C2.placeboQuantile)
        : Number.NaN;

    const survives =
      Number.isFinite(meanNetB) &&
      meanNetB > 0 &&
      Number.isFinite(meanNetC) &&
      meanNetC > 0 &&
      Number.isFinite(meanIcB) &&
      meanIcB > 0 &&
      Number.isFinite(meanIcC) &&
      meanIcC > 0 &&
      Number.isFinite(meanIcBC) &&
      Number.isFinite(placeboP90Ic) &&
      meanIcBC > placeboP90Ic;

    cells.push({
      lookback: res.lookback,
      k: res.k,
      meanNetB,
      meanNetC,
      meanIcB,
      meanIcC,
      meanIcBC,
      weeksB: weeksB.length,
      weeksC: weeksC.length,
      cashWeeksB,
      cashWeeksC,
      incompleteWeeksB,
      incompleteWeeksC,
      turnoverB,
      turnoverC,
      placeboMeanIc,
      placeboP90Ic,
      survives,
    });
  }

  // Forward choice among survivors: highest mean IC over B and C (ties: shorter lookback, then smaller k)
  const survivors = cells.filter((c) => c.survives);
  let survivor: CellSummary | null = null;

  if (survivors.length > 0) {
    const lookbackRank = (lb: number | 'all'): number => {
      if (lb === NV1_C2.lookbackWeeks[0]) return 1;
      if (lb === NV1_C2.lookbackWeeks[1]) return 2;
      return 3;
    };

    survivors.sort((a, b) => {
      const diffIc = b.meanIcBC - a.meanIcBC;
      if (Math.abs(diffIc) > 1e-12) return diffIc;
      const lbDiff = lookbackRank(a.lookback) - lookbackRank(b.lookback);
      if (lbDiff !== 0) return lbDiff;
      return a.k - b.k;
    });

    survivor = survivors[0];
  }

  return {
    cells,
    survivor,
    nullPromotionRate: placebo.nullPromotionRate,
    droppedCoinWeeks: droppedCoinWeeks ?? { training: 0, B: 0, C: 0 },
  };
}

/**
 * Runs all 12 cells and the placebo permutation null.
 */
export function runScreenAndPlacebo(
  data: Record<string, CandleRow[]> | PreparedDataset,
  placeboCount: number = NV1_C2.placeboPermutations,
  opts?: WalkForwardOptions
): ScreenResult {
  const prepared: PreparedDataset =
    'byM' in data ? (data as PreparedDataset) : prepareDataset(data as Record<string, CandleRow[]>);
  const lookbacks = NV1_C2.lookbackWeeks;
  const ks = NV1_C2.ks;

  // 1. Run actual walk-forward across all 12 cells
  const actualResults: Array<{
    lookback: number | 'all';
    k: number;
    weeks: WalkForwardWeekResult[];
  }> = [];

  for (const lb of lookbacks) {
    for (const k of ks) {
      const weeks = walkForward(prepared, lb, k, opts);
      actualResults.push({ lookback: lb, k, weeks });
    }
  }

  // 2. Run placebo permutations
  const placeboMeanIcs = new Map<string, number[]>();
  for (const lb of lookbacks) {
    for (const k of ks) {
      placeboMeanIcs.set(cellKey(lb, k), []);
    }
  }

  let passedFirstFourCount = 0;

  for (let p = 0; p < placeboCount; p++) {
    const seed = NV1_C2.placeboSeedBase + p;
    const rand = createSeededRandom(seed);

    // Deep clone and permute feature rows per coin across weeks where coin was kept
    const permWeeks: PreparedWeek[] = prepared.weeks.map((w) => ({
      M: w.M,
      coinData: new Map(),
    }));

    for (const sym of prepared.symbols) {
      const activeIndices: number[] = [];
      const featureRows: RawFeatures[] = [];

      for (let i = 0; i < prepared.weeks.length; i++) {
        const cd = prepared.weeks[i].coinData.get(sym);
        if (cd) {
          activeIndices.push(i);
          featureRows.push({ ...cd.rawFeatures });
        }
      }

      // Fisher-Yates shuffle of feature rows
      for (let i = featureRows.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = featureRows[i];
        featureRows[i] = featureRows[j];
        featureRows[j] = tmp;
      }

      for (let kIdx = 0; kIdx < activeIndices.length; kIdx++) {
        const weekIdx = activeIndices[kIdx];
        const origCd = prepared.weeks[weekIdx].coinData.get(sym)!;
        permWeeks[weekIdx].coinData.set(sym, {
          symbol: sym,
          rawFeatures: featureRows[kIdx],
          target: origCd.target,
          rawForwardReturn: origCd.rawForwardReturn,
        });
      }
    }

    const permDataset: PreparedDataset = {
      weeks: permWeeks,
      byM: new Map(permWeeks.map((w) => [w.M, w])),
      symbols: prepared.symbols,
      droppedCoinWeeks: prepared.droppedCoinWeeks,
    };

    let permPassedFirstFour = false;

    for (const lb of lookbacks) {
      for (const k of ks) {
        const weeks = walkForward(permDataset, lb, k, opts);

        const weeksB = weeks.filter(
          (w) => w.M >= NV1_SEGMENTS.B.start && w.M < NV1_SEGMENTS.B.end
        );
        const weeksC = weeks.filter(
          (w) => w.M >= NV1_SEGMENTS.C.start && w.M + WEEK_MS <= NV1_SEGMENTS.C.end
        );
        const weeksBC = [...weeksB, ...weeksC];

        const meanNetB = meanOfFinite(weeksB.map((w) => w.net));
        const meanNetC = meanOfFinite(weeksC.map((w) => w.net));
        const meanIcB = meanOfFinite(weeksB.map((w) => w.ic));
        const meanIcC = meanOfFinite(weeksC.map((w) => w.ic));
        const meanIcBC = meanOfFinite(weeksBC.map((w) => w.ic));

        placeboMeanIcs.get(cellKey(lb, k))!.push(meanIcBC);

        if (
          Number.isFinite(meanNetB) &&
          meanNetB > 0 &&
          Number.isFinite(meanNetC) &&
          meanNetC > 0 &&
          Number.isFinite(meanIcB) &&
          meanIcB > 0 &&
          Number.isFinite(meanIcC) &&
          meanIcC > 0
        ) {
          permPassedFirstFour = true;
        }
      }
    }

    if (permPassedFirstFour) {
      passedFirstFourCount++;
    }
  }

  const nullPromotionRate = placeboCount > 0 ? passedFirstFourCount / placeboCount : 0;

  return screenCells(
    actualResults,
    {
      cellMeanIcs: placeboMeanIcs,
      nullPromotionRate,
    },
    prepared.droppedCoinWeeks
  );
}

export interface CliArgs {
  command: 'run';
  datasetDir: string;
  out: string;
  placebo: number;
}

export function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] !== 'run') {
    throw new Error('Expected command "run"');
  }

  let datasetDir: string | null = null;
  let out: string | null = null;
  let placebo: number = NV1_C2.placeboPermutations;

  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return v;
    };

    if (flag === '--dataset-dir') {
      datasetDir = value();
    } else if (flag === '--out') {
      out = value();
    } else if (flag === '--placebo') {
      placebo = Number.parseInt(value(), 10);
      if (!Number.isFinite(placebo) || placebo < 0) {
        throw new Error('--placebo must be a non-negative integer');
      }
    } else {
      throw new Error(`Unknown flag "${flag}"`);
    }
  }

  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');

  return { command: 'run', datasetDir, out, placebo };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  try {
    assertC2Allowed(__dirname);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`verifyManifest failed: ${verify.mismatches.join(', ')}`);
  }

  const candlesBySymbol: Record<string, CandleRow[]> = {};
  for (const sym of NV1_SYMBOLS) {
    candlesBySymbol[sym] = loadCandles(args.datasetDir, sym, '1d', {
      allowHoldoutA: true,
      allowLockbox: false,
    }).rows;
  }

  const prepared = prepareDataset(candlesBySymbol);
  const result = runScreenAndPlacebo(prepared, args.placebo);

  writeFileSync(args.out, JSON.stringify(result, null, 2), 'utf8');
  console.log(
    JSON.stringify({
      survivor: result.survivor,
      nullPromotionRate: result.nullPromotionRate,
      droppedCoinWeeks: result.droppedCoinWeeks,
    })
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
