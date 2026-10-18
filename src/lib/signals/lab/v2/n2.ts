/**
 * lab-v2 N2 live scorer: weekly ridge, 260-week trailing window, confirmation delay k = 1.
 * Pure functions, no I/O.
 *
 * At each Monday 00:00 UTC (M), produces exactly the book that nv1-c2 walkForward(prepared, 260, 1) holds:
 * - spot 1d candles with t < M
 * - features z-scored across coins
 * - ridge fit on trailing 260 weeks with a one-week embargo
 * - predictions and centred-rank signs
 * - confirmation delay k = 1 against model fit for week M - 1w
 * - bookWeights over eligible coins, re-ranked
 * - cash when fewer than 6 coins kept/eligible, or one-sided book
 */

import { bookWeights, centredRanks, rankWeightedCorrelation } from '@/lib/stats/rank-ic';

export interface Bar1d {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  tbv?: number;
}

export const N2 = {
  lookbackWeeks: 260,
  k: 1,
  lambda: 1.0,
  minCoins: 6,
  embargoWeeks: 1,
  betaDays: 90,
  costRate: 0.0007,
} as const;

export const NV1_C2 = N2;

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** First spot bar per symbol (from the 2026-10-18 audit), and the 30-day warmup after it. */
export const NV1_LISTING: Record<string, number> = {
  BTCUSDT: Date.UTC(2017, 7, 17), ETHUSDT: Date.UTC(2017, 7, 17), BNBUSDT: Date.UTC(2017, 10, 6),
  ADAUSDT: Date.UTC(2018, 3, 17), XRPUSDT: Date.UTC(2018, 4, 4), LINKUSDT: Date.UTC(2019, 0, 16),
  DOGEUSDT: Date.UTC(2019, 6, 5), SOLUSDT: Date.UTC(2020, 7, 11), DOTUSDT: Date.UTC(2020, 7, 18),
  AVAXUSDT: Date.UTC(2020, 8, 22),
};
export const NV1_WARMUP_MS = 30 * DAY_MS;

/** Round 1 segments, UTC, half-open [start, end). */
export const NV1_SEGMENTS = {
  A1: { start: Date.UTC(2017, 7, 17), end: Date.UTC(2018, 9, 31) },
  A2: { start: Date.UTC(2018, 9, 31), end: Date.UTC(2021, 9, 14) },
  B:  { start: Date.UTC(2021, 9, 14), end: Date.UTC(2023, 9, 14) },
  C:  { start: Date.UTC(2023, 9, 14), end: Date.UTC(2026, 6, 1) },
} as const;

export function firstEligible(symbol: string): number {
  const listing = NV1_LISTING[symbol];
  if (listing === undefined) {
    throw new Error(`Unknown symbol: ${symbol}`);
  }
  return listing + NV1_WARMUP_MS;
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
export function dailyReturns(candles: Bar1d[]): DailyReturnsResult {
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
  coinCandlesOrMap: Bar1d[] | Map<number, Bar1d> | Record<string, Bar1d[]>,
  btcCandlesOrMap?: Bar1d[] | Map<number, Bar1d>
): RawFeatures {
  let coinMap: Map<number, Bar1d>;
  let btcMap: Map<number, Bar1d>;

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
    // Record<string, Bar1d[]>
    const cArr = coinCandlesOrMap[symbol] ?? [];
    coinMap = new Map();
    for (const c of cArr) coinMap.set(c.t, c);
    const bArr = coinCandlesOrMap['BTCUSDT'] ?? (symbol === 'BTCUSDT' ? cArr : []);
    btcMap = new Map();
    for (const c of bArr) btcMap.set(c.t, c);
  }

  // 90 daily returns ending Sunday before M
  // Day k (0..89): open timestamp = M - (N2.betaDays - k) * DAY_MS
  const coinReturns = new Array<number>(N2.betaDays);
  const btcReturns = new Array<number>(N2.betaDays);

  let returnsValid = true;
  for (let k = 0; k < N2.betaDays; k++) {
    const tCurr = M - (N2.betaDays - k) * DAY_MS;
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
    for (let k = 0; k < N2.betaDays; k++) {
      meanX += btcReturns[k];
      meanY += coinReturns[k];
    }
    meanX /= N2.betaDays;
    meanY /= N2.betaDays;

    let cov = 0;
    let varX = 0;
    for (let k = 0; k < N2.betaDays; k++) {
      const dx = btcReturns[k] - meanX;
      const dy = coinReturns[k] - meanY;
      cov += dx * dy;
      varX += dx * dx;
    }

    if (varX > 1e-15 && Number.isFinite(cov)) {
      const slope = cov / varX;
      beta = Math.max(0.1, Math.min(3.0, slope));

      let sum1w = 0;
      for (let k = N2.betaDays - 7; k < N2.betaDays; k++) {
        sum1w += coinReturns[k] - beta * btcReturns[k];
      }
      res1w = sum1w;

      let sum4w = 0;
      for (let k = N2.betaDays - 28; k < N2.betaDays; k++) {
        sum4w += coinReturns[k] - beta * btcReturns[k];
      }
      res4w = sum4w;
    }
  }

  // vol4w: sample standard deviation (n - 1) of daily returns over the last 28 days (indices 62..89)
  let vol4w = Number.NaN;
  if (returnsValid) {
    let mean28 = 0;
    for (let k = N2.betaDays - 28; k < N2.betaDays; k++) {
      mean28 += coinReturns[k];
    }
    mean28 /= 28;

    let sumSq = 0;
    for (let k = N2.betaDays - 28; k < N2.betaDays; k++) {
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
  for (let k = N2.betaDays - 7; k < N2.betaDays; k++) {
    const tCurr = M - (N2.betaDays - k) * DAY_MS;
    const c = coinMap.get(tCurr);
    if (!c) {
      tbsDaysValid = false;
      break;
    }
    if (c.v > 0) {
      if (c.tbv == null || !Number.isFinite(c.tbv)) {
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
  for (let k = N2.betaDays - 84; k < N2.betaDays; k++) {
    const tCurr = M - (N2.betaDays - k) * DAY_MS;
    const c = coinMap.get(tCurr);
    if (!c) {
      vtrendValid = false;
      break;
    }
    sumV84 += c.v;
    if (k >= N2.betaDays - 28) {
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
export function ridgeFit(features: number[][], y: number[], lambda: number = N2.lambda): RidgeModel {
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
  coinCandlesOrMap: Bar1d[] | Map<number, Bar1d> | Record<string, Bar1d[]>,
  btcCandlesOrMap?: Bar1d[] | Map<number, Bar1d>
): number | null {
  if (symbol === 'BTCUSDT') {
    return 0.0;
  }

  let coinMap: Map<number, Bar1d>;
  let btcMap: Map<number, Bar1d>;

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
export function prepareDataset(
  candlesBySymbol: Record<string, Bar1d[]>,
  endRebalanceMs?: number
): PreparedDataset {
  const symbols = Object.keys(candlesBySymbol);
  const candleMaps = new Map<string, Map<number, Bar1d>>();
  let minT = Number.POSITIVE_INFINITY;
  let maxT = Number.NEGATIVE_INFINITY;

  for (const s of symbols) {
    const map = new Map<number, Bar1d>();
    for (const c of candlesBySymbol[s]) {
      map.set(c.t, c);
      if (c.t < minT) minT = c.t;
      if (c.t > maxT) maxT = c.t;
    }
    candleMaps.set(s, map);
  }

  const btcMap = candleMaps.get('BTCUSDT') ?? new Map<number, Bar1d>();
  const rebalances = weeklyRebalances(minT + (N2.betaDays + 1) * DAY_MS, endRebalanceMs ?? maxT);
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
 * Pre-processes weekly training rows and kept features for all weeks.
 */
export interface WeekPreprocessed {
  M: number;
  keptCoins: string[];
  zFeatures: Map<string, number[]>; // symbol -> [res1w, res4w, vol4w, tbs1w, vtrend]
  trainingRows: Array<{ x: number[]; y: number }>;
}

export function preprocessWeeks(
  prepared: PreparedDataset,
  minCoins: number = N2.minCoins
): Map<number, WeekPreprocessed> {
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

  return preprocessed;
}

export function fitAndPredict(
  weekM: number,
  preprocessed: Map<number, WeekPreprocessed>,
  preparedWeeks: PreparedWeek[],
  lookbackWeeks: number | 'all' = N2.lookbackWeeks,
  embargoWeeks: number = N2.embargoWeeks,
  lambda: number = N2.lambda,
  minCoins: number = N2.minCoins,
  onTrainingWeeks?: (M: number, trainingWeeks: number[]) => void,
  testStart?: number,
  testEnd?: number
): { preds: Map<string, number>; signs: Map<string, number>; model: RidgeModel } | null {
  const pp = preprocessed.get(weekM);
  if (!pp || pp.keptCoins.length < minCoins) return null;

  // Collect training weeks
  const trainingWeeks: number[] = [];
  const lookbackMs = lookbackWeeks === 'all' ? Number.POSITIVE_INFINITY : lookbackWeeks * WEEK_MS;

  for (const pastWeek of preparedWeeks) {
    const W = pastWeek.M;
    if (W + embargoWeeks * WEEK_MS <= weekM && W >= weekM - lookbackMs) {
      const pastPp = preprocessed.get(W);
      if (pastPp && pastPp.trainingRows.length >= minCoins) {
        trainingWeeks.push(W);
      }
    }
  }

  if (onTrainingWeeks && testStart !== undefined && testEnd !== undefined && weekM >= testStart && weekM <= testEnd) {
    onTrainingWeeks(weekM, trainingWeeks);
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

  if (pooledX.length < minCoins) return null;

  let model: RidgeModel;
  try {
    model = ridgeFit(pooledX, pooledY, lambda);
  } catch {
    return null;
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

  const cRanks = centredRanks(predList);
  const signs = new Map<string, number>();
  for (let i = 0; i < keptList.length; i++) {
    signs.set(keptList[i], Math.sign(cRanks[i]));
  }

  return { preds, signs, model };
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
  data: Record<string, Bar1d[]> | PreparedDataset,
  lookbackWeeks: number | 'all',
  k: number,
  opts?: WalkForwardOptions
): WalkForwardWeekResult[] {
  const prepared: PreparedDataset =
    'byM' in data ? (data as PreparedDataset) : prepareDataset(data as Record<string, Bar1d[]>);

  const testStart = opts?.testStart ?? NV1_SEGMENTS.B.start;
  const testEnd = opts?.testEnd ?? NV1_SEGMENTS.C.end - WEEK_MS;
  const minCoins = opts?.minCoins ?? N2.minCoins;

  const preprocessed = preprocessWeeks(prepared, minCoins);

  const weeklyPredictions = new Map<number, Map<string, number>>();
  const weeklySigns = new Map<number, Map<string, number>>();

  for (const pw of prepared.weeks) {
    const M = pw.M;
    const res = fitAndPredict(
      M,
      preprocessed,
      prepared.weeks,
      lookbackWeeks,
      N2.embargoWeeks,
      N2.lambda,
      minCoins,
      opts?.onTrainingWeeks,
      testStart,
      testEnd
    );
    if (res) {
      weeklyPredictions.set(M, res.preds);
      weeklySigns.set(M, res.signs);
    }
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
      const cost = N2.costRate * turnover;
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
      const cost = N2.costRate * turnover;
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
      const cost = N2.costRate * turnover;
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
      const cost = N2.costRate * turnover;
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
    const cost = N2.costRate * turnover;
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

export interface N2Book {
  M: number;
  cash: boolean;
  reason: 'ok' | 'few_kept' | 'few_eligible' | 'one_sided' | 'no_model';
  predictions: Record<string, number>;
  eligible: string[];
  weights: Record<string, number>;
}

/**
 * Live scorer for N2 at rebalance week M (Monday 00:00:00 UTC).
 * Produces exactly the book that nv1-c2 walkForward(prepared, 260, 1) holds for week M:
 * - spot 1d candles with t < M (drops forming Monday bar and later)
 * - features z-scored across coins
 * - ridge fit on trailing 260 weeks with 1-week embargo
 * - confirmation delay k = 1 against model fit for week M - 1w
 * - bookWeights over eligible coins, re-ranked
 * - cash when fewer than 6 coins kept/eligible, or one-sided book
 */
export function n2BookAt(candlesBySymbol: Record<string, Bar1d[]>, M: number): N2Book {
  // Use only candles with t < M (drop the forming Monday bar and anything later)
  const filteredCandles: Record<string, Bar1d[]> = {};
  for (const sym of Object.keys(candlesBySymbol)) {
    filteredCandles[sym] = candlesBySymbol[sym].filter((b) => b.t < M);
  }

  const prepared = prepareDataset(filteredCandles, M);
  const preprocessed = preprocessWeeks(prepared, N2.minCoins);

  const ppM = preprocessed.get(M);
  if (!ppM || ppM.keptCoins.length < N2.minCoins) {
    return {
      M,
      cash: true,
      reason: 'few_kept',
      predictions: {},
      eligible: [],
      weights: {},
    };
  }

  // Model fit and prediction for week M - 1w (M - WEEK_MS)
  const prevWeekM = M - WEEK_MS;
  const prevFit = fitAndPredict(
    prevWeekM,
    preprocessed,
    prepared.weeks,
    N2.lookbackWeeks,
    N2.embargoWeeks,
    N2.lambda,
    N2.minCoins
  );

  // Model fit and prediction for week M
  const currFit = fitAndPredict(
    M,
    preprocessed,
    prepared.weeks,
    N2.lookbackWeeks,
    N2.embargoWeeks,
    N2.lambda,
    N2.minCoins
  );

  if (!currFit) {
    return {
      M,
      cash: true,
      reason: 'no_model',
      predictions: {},
      eligible: [],
      weights: {},
    };
  }

  const predictionsRecord: Record<string, number> = {};
  for (const [sym, p] of currFit.preds) {
    predictionsRecord[sym] = p;
  }

  const weeklySigns = new Map<number, Map<string, number>>();
  weeklySigns.set(M, currFit.signs);
  if (prevFit) {
    weeklySigns.set(prevWeekM, prevFit.signs);
  }

  const eligibleCoins = filterEligibleCoins(ppM.keptCoins, weeklySigns, M, N2.k);

  if (eligibleCoins.length < N2.minCoins) {
    return {
      M,
      cash: true,
      reason: 'few_eligible',
      predictions: predictionsRecord,
      eligible: eligibleCoins,
      weights: {},
    };
  }

  const eligiblePreds = eligibleCoins.map((sym) => currFit.preds.get(sym)!);
  const weightsArr = bookWeights(eligiblePreds);

  let hasLong = false;
  let hasShort = false;
  for (const w of weightsArr) {
    if (w > 0) hasLong = true;
    if (w < 0) hasShort = true;
  }

  if (!hasLong || !hasShort) {
    return {
      M,
      cash: true,
      reason: 'one_sided',
      predictions: predictionsRecord,
      eligible: eligibleCoins,
      weights: {},
    };
  }

  const weightsRecord: Record<string, number> = {};
  for (let i = 0; i < eligibleCoins.length; i++) {
    weightsRecord[eligibleCoins[i]] = weightsArr[i];
  }

  return {
    M,
    cash: false,
    reason: 'ok',
    predictions: predictionsRecord,
    eligible: eligibleCoins,
    weights: weightsRecord,
  };
}

/**
 * Returns the earliest and latest daily bar timestamps needed to score week M.
 *
 * Arithmetic:
 * - Trailing training window for week M is 260 weeks (N2.lookbackWeeks).
 * - Confirmation delay (k = 1) requires scoring week M - 1w, which has its own
 *   trailing training window of 260 weeks, extending back to M - 261 weeks (W_min).
 * - Earliest training week W_min = M - (260 + 1) * WEEK_MS = M - 261 weeks.
 * - For training week W_min, featuresAt requires:
 *   - 90 daily returns for beta estimation (N2.betaDays), plus 1 prior close day = 91 days.
 *   - 12 weeks (84 days) for volume trend (vtrend), nested within the 90-day window.
 * - Safety margin: 14 days (2 weeks).
 *
 * Total lookback = (260 + 1) * 7 days + 90 days + 84 days + 14 days = 2015 days.
 * startTime = M - 2015 * DAY_MS.
 * endTime = M - 1 (the Sunday before Monday M, dropping the forming Monday bar).
 */
export function n2HistoryNeeded(M: number): { startTime: number; endTime: number } {
  const lookbackDays = (N2.lookbackWeeks + N2.k) * 7 + N2.betaDays + 12 * 7 + 14;
  const startTime = M - lookbackDays * DAY_MS;
  const endTime = M - 1;
  return { startTime, endTime };
}
