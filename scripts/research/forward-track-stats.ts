/**
 * Pure helpers of the descriptive forward track record (see the header of forward-track.ts): the month grid and
 * labels, the directional mapping of the snipe statistics, and the per-month pooled IC of cell B. No pass/fail.
 */
import {
  TRACK_FIRST_MONTH,
  TRACK_FORWARD_FROM,
  TRACK_SPAN,
  TRACK_YEAR,
} from './forward-track';
import { pooledHorizonStat } from './factor-ic';
import { SNIPE_FEES } from './snipe';
import { bootstrapCi, excessOf, takenTrades, type SliceView, type TakenTrades } from './snipe-stats';

export type TrackLabel = 'forward' | 'used-before' | 'mixed';

export interface TrackPeriod {
  /** 'YYYY-MM' for a calendar month, 'year' for the pooled row. */
  id: string;
  label: TrackLabel;
  startMs: number;
  endMs: number;
}

function monthKey(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}`;
}

/** 'forward' iff the month key is >= TRACK_FORWARD_FROM (lexicographic on zero-padded keys), else 'used-before'. */
export function monthLabel(key: string, forwardFrom: string = TRACK_FORWARD_FROM): 'forward' | 'used-before' {
  return key >= forwardFrom ? 'forward' : 'used-before';
}

/**
 * Every UTC calendar month from `firstMonth` through the month holding `spanEnd`. A month runs from its first
 * millisecond to its last, except the final month, which ends at `spanEnd`.
 */
export function trackMonths(
  firstMonth: string = TRACK_FIRST_MONTH,
  spanEnd: string = TRACK_SPAN.end,
  forwardFrom: string = TRACK_FORWARD_FROM
): TrackPeriod[] {
  const m = /^(\d{4})-(\d{2})$/.exec(firstMonth);
  if (!m) throw new Error(`forward-track: bad first month ${firstMonth}`);
  const endLimit = Date.parse(spanEnd);
  if (Number.isNaN(endLimit)) throw new Error(`forward-track: bad span end ${spanEnd}`);
  let year = Number(m[1]);
  let month0 = Number(m[2]) - 1;
  const out: TrackPeriod[] = [];
  for (;;) {
    const startMs = Date.UTC(year, month0, 1);
    if (startMs > endLimit) break;
    const nextStart = Date.UTC(year, month0 + 1, 1);
    const key = monthKey(year, month0);
    out.push({ id: key, label: monthLabel(key, forwardFrom), startMs, endMs: Math.min(nextStart - 1, endLimit) });
    month0++;
    if (month0 > 11) {
      month0 = 0;
      year++;
    }
  }
  return out;
}

/** The months plus the pooled year row (labelled 'mixed'). */
export function trackPeriods(): TrackPeriod[] {
  return [
    ...trackMonths(),
    { id: 'year', label: 'mixed', startMs: Date.parse(TRACK_YEAR.start), endMs: Date.parse(TRACK_YEAR.end) },
  ];
}

// ---------------------------------------------------------------------------------------------------------
// A cells
// ---------------------------------------------------------------------------------------------------------

/** Maps a long-direction excess to the frozen direction: a short's excess is minus the long excess. */
export function directedExcess(longExcess: number, direction: 1 | -1): number {
  return direction === 1 ? longExcess : -longExcess;
}

/** Maps a long-direction [lo, hi] interval to the frozen direction (negated and swapped for a short). */
export function directedCi(ci: readonly [number, number], direction: 1 | -1): [number, number] {
  return direction === 1 ? [ci[0], ci[1]] : [-ci[1], -ci[0]];
}

export interface TrackACell {
  taken: number;
  resolved: number;
  /** Excess win rate over the baseline in the frozen direction. */
  excess: number;
  ci: [number, number];
  winRate: number;
  baseline: number;
  meanAtrPct: number;
  makerBreakEven: number;
  takerBreakEven: number;
}

const NAN_CI: [number, number] = [Number.NaN, Number.NaN];

export function emptyACell(taken: number = 0): TrackACell {
  return {
    taken,
    resolved: 0,
    excess: Number.NaN,
    ci: [...NAN_CI],
    winRate: Number.NaN,
    baseline: Number.NaN,
    meanAtrPct: Number.NaN,
    makerBreakEven: Number.NaN,
    takerBreakEven: Number.NaN,
  };
}

/**
 * The descriptive statistics of one A cell on one slice, computed as evaluateCell does for the quantities it
 * shares (baseline, win rate, ATR, break-even win rates), mapped to the frozen direction. No null.
 */
export function directionalACell(
  views: SliceView[],
  column: string,
  bit: number,
  direction: 1 | -1,
  bootstrap: { resamples: number; seed: number }
): TrackACell {
  const trades: TakenTrades = takenTrades(views, column, bit);
  if (trades.taken === 0) return emptyACell();
  let atrSum = 0;
  let ups = 0;
  let bSum = 0;
  let beMaker = 0;
  let beTaker = 0;
  for (let k = 0; k < trades.taken; k++) {
    const a = views[trades.symbol[k]].arrays;
    const x = a.atrPct[trades.bar[k]];
    atrSum += x;
    if (trades.y[k] < 0) continue;
    ups += trades.y[k];
    bSum += trades.b[k];
    beMaker += 0.5 + SNIPE_FEES.makerRoundTripPct / (2 * x);
    beTaker += 0.5 + SNIPE_FEES.takerRoundTripPct / (2 * x);
  }
  const r = trades.resolved;
  const meanAtrPct = atrSum / trades.taken;
  if (r === 0) return { ...emptyACell(trades.taken), meanAtrPct };
  const longWin = ups / r;
  const longBase = bSum / r;
  return {
    taken: trades.taken,
    resolved: r,
    excess: directedExcess(excessOf(trades), direction),
    ci: directedCi(bootstrapCi(views, trades, bootstrap.resamples, bootstrap.seed), direction),
    winRate: direction === -1 ? 1 - longWin : longWin,
    baseline: direction === -1 ? 1 - longBase : longBase,
    meanAtrPct,
    makerBreakEven: beMaker / r,
    takerBreakEven: beTaker / r,
  };
}

// ---------------------------------------------------------------------------------------------------------
// B cell
// ---------------------------------------------------------------------------------------------------------

export interface SymbolSeries {
  symbol: string;
  /** Signal bar timestamps. */
  timestamps: ArrayLike<number>;
  /** The factor column, parallel to timestamps. */
  factor: ArrayLike<number>;
  /** The forward return from factor-ic's helper (perp, horizon 1, execution lag 1), parallel to timestamps. */
  fwd: Float64Array;
}

/** Half-open index range [lo, hi) of the ascending timestamps inside [startMs, endMs]. */
export function indexRange(timestamps: ArrayLike<number>, startMs: number, endMs: number): [number, number] {
  let lo = 0;
  while (lo < timestamps.length && timestamps[lo] < startMs) lo++;
  let hi = lo;
  while (hi < timestamps.length && timestamps[hi] <= endMs) hi++;
  return [lo, hi];
}

export interface TrackBCell {
  ic: number;
  t: number;
  n: number;
  perSymbol: Array<{ symbol: string; ic: number | null; n: number | null }>;
  negativeSymbols: number;
}

/**
 * Pooled IC and HAC t of the pairs whose SIGNAL bar timestamp is inside [startMs, endMs], by factor-ic's own
 * pooled statistic (non-finite pairs, which include the matrix warmup, are dropped by it), plus each symbol's
 * month IC. Null statistics (too few pairs) are NaN.
 */
export function trackBCell(series: SymbolSeries[], startMs: number, endMs: number, horizon: number): TrackBCell {
  const factors: Float64Array[] = [];
  const fwds: Float64Array[] = [];
  const perSymbol: TrackBCell['perSymbol'] = [];
  for (const s of series) {
    const [lo, hi] = indexRange(s.timestamps, startMs, endMs);
    const f = Float64Array.from({ length: hi - lo }, (_, i) => s.factor[lo + i]);
    const r = s.fwd.slice(lo, hi);
    factors.push(f);
    fwds.push(r);
    const stat = pooledHorizonStat([f], [r], horizon);
    perSymbol.push({ symbol: s.symbol, ic: stat ? stat.ic : null, n: stat ? stat.n : null });
  }
  const pooled = pooledHorizonStat(factors, fwds, horizon);
  return {
    ic: pooled ? pooled.ic : Number.NaN,
    t: pooled ? pooled.icT : Number.NaN,
    n: pooled ? pooled.n : 0,
    perSymbol,
    negativeSymbols: perSymbol.filter((p) => p.ic !== null && Number.isFinite(p.ic) && p.ic < 0).length,
  };
}
