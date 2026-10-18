import { createSeededRandom } from '../../src/lib/stats/seeded-random';

/** Round 1 segments, UTC, half-open [start, end). */
export const NV1_SEGMENTS = {
  A1: { start: Date.UTC(2017, 7, 17), end: Date.UTC(2018, 9, 31) },
  A2: { start: Date.UTC(2018, 9, 31), end: Date.UTC(2021, 9, 14) },
  B:  { start: Date.UTC(2021, 9, 14), end: Date.UTC(2023, 9, 14) },
  C:  { start: Date.UTC(2023, 9, 14), end: Date.UTC(2026, 6, 1) },
} as const;
export type Nv1Segment = keyof typeof NV1_SEGMENTS;

/** First spot bar per symbol (from the 2026-10-18 audit), and the 30-day warmup after it. */
export const NV1_LISTING: Record<string, number> = {
  BTCUSDT: Date.UTC(2017, 7, 17), ETHUSDT: Date.UTC(2017, 7, 17), BNBUSDT: Date.UTC(2017, 10, 6),
  ADAUSDT: Date.UTC(2018, 3, 17), XRPUSDT: Date.UTC(2018, 4, 4), LINKUSDT: Date.UTC(2019, 0, 16),
  DOGEUSDT: Date.UTC(2019, 6, 5), SOLUSDT: Date.UTC(2020, 7, 11), DOTUSDT: Date.UTC(2020, 7, 18),
  AVAXUSDT: Date.UTC(2020, 8, 22),
};
export const NV1_WARMUP_MS = 30 * 86_400_000;
export const NV1_BALANCED_UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'XRPUSDT'] as const;

export function firstEligible(symbol: string): number {
  const listing = NV1_LISTING[symbol];
  if (listing === undefined) {
    throw new Error(`Unknown symbol: ${symbol}`);
  }
  return listing + NV1_WARMUP_MS;
}

/** One coin's aligned series on its own bar grid: t strictly increasing, gaps allowed. */
export interface CoinSeries {
  symbol: string;
  t: number[];
  close: number[];
  side: number[]; // side: +1, -1 or 0
}

export interface Trade {
  symbol: string;
  openT: number;
  closeT: number;
  d: 1 | -1;
  grossPct: number;
  netPct: number;
}

export interface TradeOptions {
  k: number;          // confirmation delay in bars, 0..3
  hold: number;       // bars held
  stepMs: number;     // bar length in ms
  costPct: number;    // round-trip cost in percent
  from: number;       // keep trades with openT >= from
  to: number;         // and closeT < to (trades fully inside the segment)
  blocked?: (index: number) => boolean; // optional: an index the null marks as unusable (wrap point)
}

/**
 * Non-overlapping trades for one coin.
 * - A trade OPENS at index i (at the close of bar i) when the coin is flat, side[i] !== 0, side[j] === side[i]
 *   for every j in i-k..i, and the bars i-k..i are contiguous (t[j] - t[j-1] === stepMs).
 * - It CLOSES at index c = i + hold, and only if t[c] - t[i] === hold * stepMs (no gap inside); otherwise
 *   no trade is taken at i and the coin stays flat.
 * - While a trade is open (indices i+1..c-1) no trade opens; the next possible open index is c.
 * - It is skipped (coin stays flat) if any index in i-k..c is blocked, or if t[i] < firstEligible(symbol).
 * - d = side[i]; grossPct = d * (close[c] / close[i] - 1) * 100; netPct = grossPct - costPct.
 * - Only trades with openT >= from and closeT < to are returned (the state machine still runs over the
 *   whole series, so a trade that would start before `from` still blocks later opens while it is open).
 */
export function buildTrades(series: CoinSeries, opts: TradeOptions): Trade[] {
  const trades: Trade[] = [];
  const n = series.t.length;
  const eligibleT = firstEligible(series.symbol);

  let i = 0;
  while (i < n) {
    const d = series.side[i];
    if (d !== 1 && d !== -1) {
      i++;
      continue;
    }

    if (i - opts.k < 0) {
      i++;
      continue;
    }

    let confirmed = true;
    for (let j = i - opts.k; j <= i; j++) {
      if (series.side[j] !== d) {
        confirmed = false;
        break;
      }
      if (j > i - opts.k && series.t[j] - series.t[j - 1] !== opts.stepMs) {
        confirmed = false;
        break;
      }
    }
    if (!confirmed) {
      i++;
      continue;
    }

    const c = i + opts.hold;
    if (c >= n) {
      i++;
      continue;
    }

    if (series.t[c] - series.t[i] !== opts.hold * opts.stepMs) {
      i++;
      continue;
    }

    if (series.t[i] < eligibleT) {
      i++;
      continue;
    }

    if (opts.blocked) {
      let isBlocked = false;
      for (let j = i - opts.k; j <= c; j++) {
        if (opts.blocked(j)) {
          isBlocked = true;
          break;
        }
      }
      if (isBlocked) {
        i++;
        continue;
      }
    }

    const openT = series.t[i];
    const closeT = series.t[c];
    const grossPct = d * (series.close[c] / series.close[i] - 1) * 100;
    const netPct = grossPct - opts.costPct;

    if (openT >= opts.from && closeT < opts.to) {
      trades.push({
        symbol: series.symbol,
        openT,
        closeT,
        d,
        grossPct,
        netPct,
      });
    }

    i = c;
  }

  return trades;
}

/** Mean netPct over all trades (equal weight per trade), NaN for none. */
export function meanNet(trades: Trade[]): number {
  if (trades.length === 0) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < trades.length; i++) {
    sum += trades[i].netPct;
  }
  return sum / trades.length;
}

/**
 * Rotates each coin's side series within the coin's own index range by offset_c = Math.round(u * n_c) (n_c = the
 * coin's bar count), result[j] = side[(j - offset_c + n_c) % n_c]. t and close are unchanged. Returns the new series
 * and, per coin, its wrap index offset_c (the index where the rotated series restarts from the original index 0).
 */
export function rotateWithinSpans(
  coins: CoinSeries[],
  u: number
): { coins: CoinSeries[]; wrap: number[] } {
  const wrap: number[] = [];
  const rotatedCoins: CoinSeries[] = coins.map((coin) => {
    const n = coin.side.length;
    if (n === 0) {
      wrap.push(0);
      return {
        symbol: coin.symbol,
        t: coin.t,
        close: coin.close,
        side: [],
      };
    }
    const offset = Math.round(u * n);
    wrap.push(offset);
    const newSide = new Array<number>(n);
    for (let j = 0; j < n; j++) {
      newSide[j] = coin.side[((j - offset) % n + n) % n];
    }
    return {
      symbol: coin.symbol,
      t: coin.t,
      close: coin.close,
      side: newSide,
    };
  });

  return {
    coins: rotatedCoins,
    wrap,
  };
}

/** u uniform over [m, 1 - m] with m = minShiftBars / min over coins of n_c; throws if m >= 0.5. */
export function drawFraction(
  coins: CoinSeries[],
  minShiftBars: number,
  random: () => number
): number {
  if (coins.length === 0) {
    throw new RangeError('drawFraction: coins array is empty');
  }
  let minNc = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coins.length; i++) {
    const len = coins[i].side.length;
    if (len < minNc) {
      minNc = len;
    }
  }
  if (!Number.isFinite(minNc) || minNc <= 0) {
    throw new RangeError('drawFraction: shortest coin has length 0');
  }
  const m = minShiftBars / minNc;
  if (m >= 0.5) {
    throw new RangeError(
      `drawFraction: minShiftBars (${minShiftBars}) is at least half shortest coin (${minNc}), m = ${m}`
    );
  }
  return m + random() * (1 - 2 * m);
}

/**
 * Sum and count of netPct over non-overlapping trades, following the same execution rules as buildTrades.
 */
export function sumNetTrades(
  series: {
    symbol: string;
    t: ArrayLike<number>;
    close: ArrayLike<number>;
    side: ArrayLike<number>;
  },
  opts: TradeOptions
): { sum: number; count: number } {
  const n = series.t.length;
  const eligibleT = firstEligible(series.symbol);
  const k = opts.k;
  const hold = opts.hold;
  const stepMs = opts.stepMs;
  const holdStepMs = hold * stepMs;
  const costPct = opts.costPct;
  const from = opts.from;
  const to = opts.to;
  const blocked = opts.blocked;

  const t = series.t;
  const close = series.close;
  const side = series.side;

  let sum = 0;
  let count = 0;

  let i = 0;
  while (i < n) {
    const d = side[i];
    if (d !== 1 && d !== -1) {
      i++;
      continue;
    }

    if (i - k < 0) {
      i++;
      continue;
    }

    let confirmed = true;
    for (let j = i - k; j <= i; j++) {
      if (side[j] !== d) {
        confirmed = false;
        break;
      }
      if (j > i - k && t[j] - t[j - 1] !== stepMs) {
        confirmed = false;
        break;
      }
    }
    if (!confirmed) {
      i++;
      continue;
    }

    const c = i + hold;
    if (c >= n) {
      i++;
      continue;
    }

    if (t[c] - t[i] !== holdStepMs) {
      i++;
      continue;
    }

    if (t[i] < eligibleT) {
      i++;
      continue;
    }

    if (blocked) {
      let isBlocked = false;
      for (let j = i - k; j <= c; j++) {
        if (blocked(j)) {
          isBlocked = true;
          break;
        }
      }
      if (isBlocked) {
        i++;
        continue;
      }
    }

    const openT = t[i];
    const closeT = t[c];
    const grossPct = d * (close[c] / close[i] - 1) * 100;
    const netPct = grossPct - costPct;

    if (openT >= from && closeT < to) {
      sum += netPct;
      count++;
    }

    i = c;
  }

  return { sum, count };
}

/**
 * Null draws of N for each k: for each draw, one common fraction u, rotate each coin within its span,
 * then for each k and coin build trades with wrap index blocked, pool, and return meanNet.
 * Result is draws x ks.
 */
export function nullN(
  coins: CoinSeries[],
  ks: number[],
  base: Omit<TradeOptions, 'k' | 'blocked'>,
  draws: number,
  minShiftBars: number,
  seed: number
): number[][] {
  const random = createSeededRandom(seed);
  const preparedCoins = coins.map((coin) => {
    const n = coin.side.length;
    const t = new Float64Array(coin.t);
    const close = new Float64Array(coin.close);
    const origSide = new Int8Array(coin.side);
    const rotSide = new Int8Array(n);
    return {
      symbol: coin.symbol,
      n,
      t,
      close,
      origSide,
      rotSide,
      coinData: {
        symbol: coin.symbol,
        t,
        close,
        side: rotSide,
      },
    };
  });

  const result: number[][] = [];

  for (let d = 0; d < draws; d++) {
    const u = drawFraction(coins, minShiftBars, random);
    const wrap: number[] = new Array(preparedCoins.length);

    for (let c = 0; c < preparedCoins.length; c++) {
      const pc = preparedCoins[c];
      const n = pc.n;
      const offset = Math.round(u * n);
      wrap[c] = offset;
      const split = n - offset;
      pc.rotSide.set(pc.origSide.subarray(split), 0);
      pc.rotSide.set(pc.origSide.subarray(0, split), offset);
    }

    const row: number[] = [];
    for (let ki = 0; ki < ks.length; ki++) {
      const k = ks[ki];
      let pooledSum = 0;
      let pooledCount = 0;

      for (let c = 0; c < preparedCoins.length; c++) {
        const pc = preparedCoins[c];
        const wrapIndex = wrap[c];
        const res = sumNetTrades(pc.coinData, {
          ...base,
          k,
          blocked: (index: number) => index === wrapIndex,
        });
        pooledSum += res.sum;
        pooledCount += res.count;
      }

      row.push(pooledCount > 0 ? pooledSum / pooledCount : Number.NaN);
    }

    result.push(row);
  }

  return result;
}

/** Per-k mean and sample sd (n - 1) over the rows of a draws x ks matrix. */
export function nullMoments(nulls: number[][]): { mean: number[]; sd: number[] } {
  const numDraws = nulls.length;
  if (numDraws === 0) {
    return { mean: [], sd: [] };
  }
  const numK = nulls[0].length;
  const mean = new Array<number>(numK).fill(0);
  const sd = new Array<number>(numK).fill(0);

  for (let k = 0; k < numK; k++) {
    let sum = 0;
    for (let r = 0; r < numDraws; r++) {
      sum += nulls[r][k];
    }
    const m = sum / numDraws;
    mean[k] = m;

    if (numDraws > 1) {
      let sumSqDiff = 0;
      for (let r = 0; r < numDraws; r++) {
        const diff = nulls[r][k] - m;
        sumSqDiff += diff * diff;
      }
      sd[k] = Math.sqrt(sumSqDiff / (numDraws - 1));
    } else {
      sd[k] = Number.NaN;
    }
  }

  return { mean, sd };
}

/** max over k (ignoring k whose `assessable[k]` is false) of (N_k - mean_k) / sd_k. NaN if none assessable. */
export function maxStandardised(
  n: number[],
  moments: { mean: number[]; sd: number[] },
  assessable: boolean[]
): number {
  let max = -Infinity;
  let found = false;

  for (let k = 0; k < n.length; k++) {
    if (!assessable[k]) continue;
    const sdK = moments.sd[k];
    const meanK = moments.mean[k];
    const z = (n[k] - meanK) / sdK;
    if (!Number.isNaN(z)) {
      if (!found || z > max) {
        max = z;
      }
      found = true;
    }
  }

  return found ? max : Number.NaN;
}

/** Type-7 quantile of an unsorted array (copy then sort). */
export function quantile7(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  if (values.length === 1) return values[0];
  if (p <= 0) {
    const copy = [...values].sort((a, b) => a - b);
    return copy[0];
  }
  if (p >= 1) {
    const copy = [...values].sort((a, b) => a - b);
    return copy[copy.length - 1];
  }

  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * p;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  if (lower === upper) return sorted[lower];
  const weight = h - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
