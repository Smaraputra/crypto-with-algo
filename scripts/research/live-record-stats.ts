/**
 * Pure measures, moving-block bootstrap and verdict rules of the live-record study.
 * The binding spec is the header of scripts/research/live-record.ts; nothing here
 * reads a database or a file.
 */
import { spearman } from './ic-stats';
import { seededRandom } from './carry-sim';
import {
  LIVE_RECORD_BUY_TIERS,
  LIVE_RECORD_MIN_HORIZONS,
  LIVE_RECORD_MIN_SIDE_ROWS,
  LIVE_RECORD_SELL_TIERS,
  LIVE_RECORD_STRONG_TIERS,
  LIVE_RECORD_VERDICT_LEVEL,
} from './live-record';

export interface LiveRow {
  symbol: string;
  interval: string;
  tradingStyle: string;
  tier: string;
  score: number;
  configVersion: number;
  candleTimestamp: number;
  horizonBars: number;
  forwardReturnPercent: number;
}

const BUY = new Set<string>(LIVE_RECORD_BUY_TIERS);
const SELL = new Set<string>(LIVE_RECORD_SELL_TIERS);
const STRONG = new Set<string>(LIVE_RECORD_STRONG_TIERS);
const ALL_TIERS = ['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell'] as const;

export interface SideMeasures {
  buyN: number;
  sellN: number;
  /** Balanced hit rate; NaN when either side has no row. */
  bh: number;
  /** mean(fwd | BUY) - mean(fwd | SELL) in percent; NaN when either side has no row. */
  s: number;
  /** mean(d x fwd) - cost over BUY and SELL rows; NaN when there are none. */
  net: number;
}

export interface TierMeasures {
  count: number;
  meanFwd: number;
  /** Directional hit rate: fwd > 0 for buy tiers, fwd < 0 for sell tiers, NaN for neutral. */
  hitRate: number;
}

export interface CellMeasures extends SideMeasures {
  rows: number;
  tiers: Record<string, TierMeasures>;
  strong: SideMeasures;
  /** Spearman rank correlation of score with fwd over every row of the cell. */
  spearman: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function sideMeasures(rows: LiveRow[], tiers: Set<string>, costPercent: number): SideMeasures {
  const buy: number[] = [];
  const sell: number[] = [];
  for (const r of rows) {
    if (!tiers.has(r.tier)) continue;
    if (BUY.has(r.tier)) buy.push(r.forwardReturnPercent);
    else if (SELL.has(r.tier)) sell.push(r.forwardReturnPercent);
  }
  const buyHit = buy.filter((v) => v > 0).length / buy.length;
  const sellHit = sell.filter((v) => v < 0).length / sell.length;
  const directional = buy.length + sell.length;
  let net = NaN;
  if (directional > 0) {
    let sum = 0;
    for (const v of buy) sum += v;
    for (const v of sell) sum -= v;
    net = sum / directional - costPercent;
  }
  return {
    buyN: buy.length,
    sellN: sell.length,
    bh: buy.length > 0 && sell.length > 0 ? (buyHit + sellHit) / 2 : NaN,
    s: buy.length > 0 && sell.length > 0 ? mean(buy) - mean(sell) : NaN,
    net,
  };
}

const ALL_DIRECTIONAL = new Set<string>([...LIVE_RECORD_BUY_TIERS, ...LIVE_RECORD_SELL_TIERS]);

/** BH, S and N (cost passed in), per-tier counts, mean fwd and hit rate, STRONG-tier measures, Spearman. */
export function cellMeasures(rows: LiveRow[], costPercent: number): CellMeasures {
  const tiers: Record<string, TierMeasures> = {};
  for (const tier of ALL_TIERS) {
    const fwd = rows.filter((r) => r.tier === tier).map((r) => r.forwardReturnPercent);
    let hitRate = NaN;
    if (fwd.length > 0 && BUY.has(tier)) hitRate = fwd.filter((v) => v > 0).length / fwd.length;
    if (fwd.length > 0 && SELL.has(tier)) hitRate = fwd.filter((v) => v < 0).length / fwd.length;
    tiers[tier] = { count: fwd.length, meanFwd: mean(fwd), hitRate };
  }
  return {
    rows: rows.length,
    ...sideMeasures(rows, ALL_DIRECTIONAL, costPercent),
    tiers,
    strong: sideMeasures(rows, STRONG, costPercent),
    spearman: spearman(
      rows.map((r) => r.score),
      rows.map((r) => r.forwardReturnPercent)
    ),
  };
}

/** Type 7 percentile (linear interpolation) of an ascending-sorted array; p in [0, 1]. */
export function percentileType7(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export interface MeasureInterval {
  lo95: number;
  hi95: number;
  lo99: number;
  hi99: number;
  /** Percentiles at the optional `level` passed to blockBootstrap, else absent. */
  loLevel?: number;
  hiLevel?: number;
  /** Resamples whose measure was finite. */
  finite: number;
}

/**
 * Moving-block bootstrap over time. Timeline = sorted distinct candleTimestamps (T); a block is
 * L = horizonBars consecutive timeline positions (capped at T) from a uniform start in [0, T - L];
 * every row at a drawn timestamp is included; blocks are appended until the resampled timeline
 * reaches T positions (the last block truncated). Returns the 2.5/97.5 and 0.5/99.5 percentiles
 * of each measure the function returns.
 */
export function blockBootstrap(
  rows: LiveRow[],
  horizonBars: number,
  measureFn: (resampled: LiveRow[]) => Record<string, number>,
  resamples: number,
  seed: number,
  level?: number
): Record<string, MeasureInterval> {
  const byTs = new Map<number, LiveRow[]>();
  for (const r of rows) {
    const bucket = byTs.get(r.candleTimestamp);
    if (bucket) bucket.push(r);
    else byTs.set(r.candleTimestamp, [r]);
  }
  const timeline = [...byTs.keys()].sort((a, b) => a - b);
  const groups = timeline.map((ts) => byTs.get(ts) as LiveRow[]);
  const T = timeline.length;
  if (T === 0) return {};
  const L = Math.max(1, Math.min(Math.floor(horizonBars), T));
  const random = seededRandom(seed);
  const samples: Record<string, number[]> = {};

  for (let b = 0; b < resamples; b++) {
    const drawn: LiveRow[] = [];
    let filled = 0;
    while (filled < T) {
      const start = Math.floor(random() * (T - L + 1));
      const take = Math.min(L, T - filled);
      for (let k = 0; k < take; k++) {
        const g = groups[start + k];
        for (let i = 0; i < g.length; i++) drawn.push(g[i]);
      }
      filled += take;
    }
    const m = measureFn(drawn);
    for (const key of Object.keys(m)) {
      if (!Number.isFinite(m[key])) continue;
      (samples[key] ??= []).push(m[key]);
    }
  }

  const out: Record<string, MeasureInterval> = {};
  for (const key of Object.keys(samples)) {
    const sorted = samples[key].sort((a, b) => a - b);
    out[key] = {
      lo95: percentileType7(sorted, 0.025),
      hi95: percentileType7(sorted, 0.975),
      lo99: percentileType7(sorted, 0.005),
      hi99: percentileType7(sorted, 0.995),
      finite: sorted.length,
      ...(level === undefined
        ? {}
        : {
            loLevel: percentileType7(sorted, (1 - level) / 2),
            hiLevel: percentileType7(sorted, 1 - (1 - level) / 2),
          }),
    };
  }
  return out;
}

export interface Interval99 {
  lo99: number;
  hi99: number;
}

export type Verdict = 'NOT ASSESSABLE' | 'RIGHT' | 'WRONG-WAY' | 'PAYS' | 'NO DETECTABLE EDGE';

export interface VerdictInput {
  /** Timeline span in horizons: (last - first candleTimestamp) / interval / horizonBars. */
  spanHorizons: number;
  buyN: number;
  sellN: number;
  /** 99% interval of BH itself (0.5 is subtracted here). */
  bh: Interval99;
  s: Interval99;
  net: Interval99;
}

export interface VerdictResult {
  verdict: Verdict;
  notAssessable: boolean;
  right: boolean;
  wrongWay: boolean;
  pays: boolean;
  level: number;
  /** 99% half-widths: the smallest edge the sample could have shown. */
  halfWidths: { bh: number; s: number; net: number };
}

const halfWidth = (i: Interval99): number => (i.hi99 - i.lo99) / 2;

/** The header's verdict rules. RIGHT and PAYS can both hold; both flags are recorded, the label prefers RIGHT. */
export function verdictOf(input: VerdictInput, level: number = LIVE_RECORD_VERDICT_LEVEL): VerdictResult {
  const halfWidths = { bh: halfWidth(input.bh), s: halfWidth(input.s), net: halfWidth(input.net) };
  const base = { level, halfWidths };
  if (
    !(input.spanHorizons >= LIVE_RECORD_MIN_HORIZONS) ||
    input.buyN < LIVE_RECORD_MIN_SIDE_ROWS ||
    input.sellN < LIVE_RECORD_MIN_SIDE_ROWS
  ) {
    return { ...base, verdict: 'NOT ASSESSABLE', notAssessable: true, right: false, wrongWay: false, pays: false };
  }
  const bhLo = input.bh.lo99 - 0.5;
  const bhHi = input.bh.hi99 - 0.5;
  const right = bhLo > 0 && input.s.lo99 > 0;
  const wrongWay = bhHi < 0 && input.s.hi99 < 0;
  const pays = input.net.lo99 > 0;
  const verdict: Verdict = right ? 'RIGHT' : wrongWay ? 'WRONG-WAY' : pays ? 'PAYS' : 'NO DETECTABLE EDGE';
  return { ...base, verdict, notAssessable: false, right, wrongWay, pays };
}

/**
 * Single-pass subset of cellMeasures for the bootstrap hot loop (BH, S, N and the STRONG tiers'
 * BH, S, N; no Spearman, which is reported as a point estimate only). Equals cellMeasures on these keys.
 */
export function bootstrapMeasures(rows: LiveRow[], costPercent: number): Record<string, number> {
  const acc = {
    all: { b: 0, bs: 0, bh: 0, s: 0, ss: 0, sh: 0 },
    strong: { b: 0, bs: 0, bh: 0, s: 0, ss: 0, sh: 0 },
  };
  for (const r of rows) {
    const isBuy = BUY.has(r.tier);
    if (!isBuy && !SELL.has(r.tier)) continue;
    const f = r.forwardReturnPercent;
    const targets = STRONG.has(r.tier) ? [acc.all, acc.strong] : [acc.all];
    for (const t of targets) {
      if (isBuy) {
        t.b++;
        t.bs += f;
        if (f > 0) t.bh++;
      } else {
        t.s++;
        t.ss += f;
        if (f < 0) t.sh++;
      }
    }
  }
  const finish = (t: typeof acc.all): { bh: number; s: number; net: number } => {
    const both = t.b > 0 && t.s > 0;
    return {
      bh: both ? (t.bh / t.b + t.sh / t.s) / 2 : NaN,
      s: both ? t.bs / t.b - t.ss / t.s : NaN,
      net: t.b + t.s > 0 ? (t.bs - t.ss) / (t.b + t.s) - costPercent : NaN,
    };
  };
  const a = finish(acc.all);
  const g = finish(acc.strong);
  return { bh: a.bh, s: a.s, net: a.net, strongBh: g.bh, strongS: g.s, strongNet: g.net };
}
