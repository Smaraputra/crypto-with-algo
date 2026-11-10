/**
 * LOCKED READ: BINANCE AGAINST HYPERLIQUID FUNDING SPREAD, FORWARD BOOK SIMULATOR.
 *
 * The specification is `.superpowers/sdd/venue-frontier/lock-draft.md` (v2),
 * sections 3 to 6. This module simulates the whole book causally: at each
 * decision time T on the 8h grid it sees only data at or before T (funding with
 * event time <= T, and the OPEN of the bar at T), closes positions, then opens
 * new ones in a fixed order. There is no precomputed episode list and no post-hoc
 * slot book.
 *
 * Order inside one decision time T (simulateBook):
 *   1. liquidation check of every position held across the step (T - 8h, T];
 *   2. exit test (price availability, end of span, sign flip);
 *   3. entries (crossings of the spread level), or the delayed variant.
 * Ties between crossings: larger |S| first, then Hyperliquid coin name ascending
 * by code unit.
 *
 * SPAN GUARD. Any run whose span end is after READ_CUTOFF_MS (2024-07-01 00:00
 * UTC) needs the signed lock file and its sha256, and refuses to run when
 * `<out>.read-done` exists (`assertSpanAllowed`). Every external request builder
 * checks its end time against the span end of the run. The older date guards in
 * ./venue-funding-scout and ./funding-scout are not used and not edited.
 *
 * Usage:
 *   npx tsx scripts/research/venue-spread-locked.ts --universe <universe-source.json> \
 *     --cache <dir> --out <report.json> --hl-meta <meta.json> --from <ISO> --end <ISO> \
 *     [--coins A,B] [--concurrency 3] [--lock-file <file> --lock-sha256 <hex>]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fetchArchiveFile, parseFundingCsv, parseKlineCsv, type FundingCsvRow } from '@/lib/external/binance-archive';
import { settlementTimeOf } from '@/lib/funding-settlements';

import { HOUR_MS } from './carry-sim';
import { SCOUT_CUTOFF_MS, SCOUT_FROM_MS, quantile, type ScoutSettlement } from './funding-scout';
import type { UniverseFolder, UniverseSource } from './universe-source';
import {
  ApiClient,
  CANDLE_MS,
  HYPERLIQUID_URL,
  asRecord,
  dedupeByHour,
  hyperliquidCoinFor,
  mulberry32,
  parseHyperliquidMeta,
  postInit,
  safeName,
  toNum,
} from './venue-funding-scout';

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

/** Tolerance on threshold comparisons. */
export const EPS = 1e-12;
export const STEP_MS = 8 * HOUR_MS;
/** Exclusive: a run whose span end is later than this needs the signed lock. */
export const READ_CUTOFF_MS = SCOUT_CUTOFF_MS;

const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

export const LOCKED_SLOTS = 10;
export const LOCKED_LEVEL = 0.002;
export const LOCKED_PER_SIDE = 0.00185;
export const LOCKED_SEED = 20261111;
export const LOCKED_HURDLE = 0.05;
/** Long leg liquidated at a low of this fraction of its entry open or less. */
const LIQ_LOW_FRACTION = 0.005;
/** Short leg liquidated at a high of this multiple of its entry open or more. */
const LIQ_HIGH_MULTIPLE = 1.995;

export interface PriceBar {
  open: number;
  high: number;
  low: number;
}

export interface BinanceEvent {
  t: number;
  rate: number;
  intervalHours: number;
}

export interface CoinSeries {
  /** Hyperliquid coin name. */
  coin: string;
  /** Binance folder name. */
  symbol: string;
  /** Binance settlements, ascending by t. */
  bf: readonly BinanceEvent[];
  /** Hyperliquid hourly funding, ascending by t, one per hour. */
  hf: readonly { t: number; rate: number }[];
  /** Binance 1h bars keyed by open time. */
  bpx: ReadonlyMap<number, PriceBar>;
  /** Hyperliquid 8h candles keyed by open time. */
  hpx: ReadonlyMap<number, PriceBar>;
}

export interface LockedParams {
  /** First decision time (ms). */
  fromT: number;
  /** Last decision time (ms), on the 8h grid from fromT. */
  lastT: number;
  slots: number;
  level: number;
  perSide: number;
  entryDelaySteps: 0 | 1;
}

export type ExitReason = 'signal' | 'unavailable' | 'end' | 'liquidated';

export interface Position {
  coin: string;
  symbol: string;
  sign: 1 | -1;
  entryT: number;
  exitT: number;
  entryS: number;
  funding: number;
  basis: number;
  net: number;
  reason: ExitReason;
}

export interface BookResult {
  positions: Position[];
  counts: { noSlot: number; noPrice: number; noCoverage: number };
}

// ---------------------------------------------------------------------------
// Window sums (binary search; sums are always taken in ascending time order)
// ---------------------------------------------------------------------------

/** First index whose t is strictly greater than `t` (events are ascending). */
function firstAfter(events: readonly { t: number }[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].t > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Sum of rate over events with lo < t <= hi, and how many there were. */
function windowSum(events: readonly { t: number; rate: number }[], lo: number, hi: number): { sum: number; count: number } {
  const i0 = firstAfter(events, lo);
  const i1 = firstAfter(events, hi);
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += events[i].rate;
  return { sum, count: Math.max(0, i1 - i0) };
}

/**
 * The trailing 24h funding spread at T: Hyperliquid sum minus Binance sum over
 * events with T - 24h < t <= T. Null when coverage fails: Hyperliquid needs at
 * least 22 events, Binance at least 24 / intervalHours - 1 events, where
 * intervalHours is that of the latest Binance event with t <= T (null when none).
 */
export function spreadAt(series: CoinSeries, T: number): number | null {
  const lo = T - 24 * HOUR_MS;
  const hl = windowSum(series.hf, lo, T);
  const bn = windowSum(series.bf, lo, T);
  const latest = firstAfter(series.bf, T) - 1;
  if (latest < 0) return null;
  const intervalHours = series.bf[latest].intervalHours;
  if (hl.count < 22) return null;
  if (bn.count < 24 / intervalHours - 1) return null;
  return hl.sum - bn.sum;
}

// ---------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------

interface OpenPosition {
  series: CoinSeries;
  sign: 1 | -1;
  entryT: number;
  entryS: number;
  bEntry: number;
  hEntry: number;
  lastPriceT: number;
  lastB: number;
  lastH: number;
}

interface Crossing {
  series: CoinSeries;
  sign: 1 | -1;
  entryS: number;
  abs: number;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertParams(params: LockedParams): void {
  const { fromT, lastT, slots, entryDelaySteps } = params;
  if (!Number.isFinite(fromT) || !Number.isFinite(lastT)) throw new Error('fromT and lastT must be finite');
  if (lastT < fromT) throw new Error('lastT is before fromT');
  if ((lastT - fromT) % STEP_MS !== 0) throw new Error('lastT must be on the 8h grid from fromT');
  if (!Number.isInteger(slots) || slots < 1) throw new Error('slots must be a positive integer');
  if (entryDelaySteps !== 0 && entryDelaySteps !== 1) throw new Error('entryDelaySteps must be 0 or 1');
}

/**
 * Whether the long and short legs of a position were liquidated over the step
 * (T - 8h, T]. The long leg is Binance when sign is +1, else Hyperliquid.
 */
function liquidationOver(op: OpenPosition, T: number): { longLiq: boolean; shortLiq: boolean } {
  const stepStart = T - STEP_MS;
  let bLow = Number.POSITIVE_INFINITY;
  let bHigh = Number.NEGATIVE_INFINITY;
  let bSeen = false;
  for (let k = 0; k < 8; k++) {
    const bar = op.series.bpx.get(stepStart + k * HOUR_MS);
    if (bar === undefined) continue;
    bSeen = true;
    if (bar.low < bLow) bLow = bar.low;
    if (bar.high > bHigh) bHigh = bar.high;
  }
  const candle = op.series.hpx.get(stepStart);

  const longIsBinance = op.sign === 1;
  let longLiq = false;
  let shortLiq = false;
  if (longIsBinance) {
    if (bSeen) longLiq = bLow <= LIQ_LOW_FRACTION * op.bEntry;
    if (candle !== undefined) shortLiq = candle.high >= LIQ_HIGH_MULTIPLE * op.hEntry;
  } else {
    if (candle !== undefined) longLiq = candle.low <= LIQ_LOW_FRACTION * op.hEntry;
    if (bSeen) shortLiq = bHigh >= LIQ_HIGH_MULTIPLE * op.bEntry;
  }
  return { longLiq, shortLiq };
}

function closePosition(
  op: OpenPosition,
  exitT: number,
  bExit: number,
  hExit: number,
  reason: ExitReason,
  perSide: number,
  liq: { longLiq: boolean; shortLiq: boolean }
): Position {
  const hl = windowSum(op.series.hf, op.entryT, exitT).sum;
  const bn = windowSum(op.series.bf, op.entryT, exitT).sum;
  const funding = op.sign * (hl - bn);

  const longIsBinance = op.sign === 1;
  const longEntry = longIsBinance ? op.bEntry : op.hEntry;
  const longExit = longIsBinance ? bExit : hExit;
  const shortEntry = longIsBinance ? op.hEntry : op.bEntry;
  const shortExit = longIsBinance ? hExit : bExit;
  const longReturn = liq.longLiq ? -1 : longExit / longEntry - 1;
  const shortReturn = liq.shortLiq ? -1 : -(shortExit / shortEntry - 1);
  const basis = longReturn + shortReturn;

  return {
    coin: op.series.coin,
    symbol: op.series.symbol,
    sign: op.sign,
    entryT: op.entryT,
    exitT,
    entryS: op.entryS,
    funding,
    basis,
    net: funding + basis - 2 * perSide,
    reason,
  };
}

const NO_LIQ = { longLiq: false, shortLiq: false };

/**
 * The forward book (lock section 4). Positions come back sorted by entryT, then
 * coin ascending.
 */
export function simulateBook(series: readonly CoinSeries[], params: LockedParams): BookResult {
  assertParams(params);
  const { fromT, lastT, slots, level, perSide, entryDelaySteps } = params;

  const positions: Position[] = [];
  const counts = { noSlot: 0, noPrice: 0, noCoverage: 0 };
  let open: OpenPosition[] = [];
  const held = new Set<string>();
  let queue: Crossing[] = [];

  const spreadCache = new Map<CoinSeries, Map<number, number | null>>();
  const spread = (s: CoinSeries, T: number): number | null => {
    let byT = spreadCache.get(s);
    if (byT === undefined) {
      byT = new Map();
      spreadCache.set(s, byT);
    }
    if (byT.has(T)) return byT.get(T) ?? null;
    const value = spreadAt(s, T);
    byT.set(T, value);
    return value;
  };

  const close = (op: OpenPosition, exitT: number, b: number, h: number, reason: ExitReason, liq = NO_LIQ): void => {
    positions.push(closePosition(op, exitT, b, h, reason, perSide, liq));
    held.delete(op.series.coin);
  };

  const enter = (c: Crossing, T: number, b: number, h: number): void => {
    open.push({
      series: c.series,
      sign: c.sign,
      entryT: T,
      entryS: c.entryS,
      bEntry: b,
      hEntry: h,
      lastPriceT: T,
      lastB: b,
      lastH: h,
    });
    held.add(c.series.coin);
  };

  for (let T = fromT; T <= lastT; T += STEP_MS) {
    // Step 1: liquidation of positions held across the step (T - 8h, T].
    const afterLiquidation: OpenPosition[] = [];
    for (const op of open) {
      if (op.entryT < T) {
        const liq = liquidationOver(op, T);
        if (liq.longLiq || liq.shortLiq) {
          const b = op.series.bpx.get(T);
          const h = op.series.hpx.get(T);
          if (b !== undefined && h !== undefined) {
            close(op, T, b.open, h.open, 'liquidated', liq);
            continue;
          }
          // A price at T is missing: no liquidation override, the exit test closes it as unavailable.
        }
      }
      afterLiquidation.push(op);
    }

    // Step 2: exit test.
    const remaining: OpenPosition[] = [];
    for (const op of afterLiquidation) {
      const b = op.series.bpx.get(T);
      const h = op.series.hpx.get(T);
      if (b === undefined || h === undefined) {
        close(op, op.lastPriceT, op.lastB, op.lastH, 'unavailable');
        continue;
      }
      op.lastPriceT = T;
      op.lastB = b.open;
      op.lastH = h.open;
      if (T === lastT) {
        close(op, T, b.open, h.open, 'end');
        continue;
      }
      const S = spread(op.series, T);
      if (S !== null && op.sign * S <= EPS) {
        close(op, T, b.open, h.open, 'signal');
        continue;
      }
      remaining.push(op);
    }
    open = remaining;

    // Step 3: entries.
    if (entryDelaySteps === 1) {
      // Queued crossings from T - 8h execute at the opens of T. At lastT nothing may enter, so they are dropped.
      const due = queue;
      queue = [];
      if (T < lastT) {
        for (const c of due) {
          if (held.has(c.series.coin)) continue;
          const b = c.series.bpx.get(T);
          const h = c.series.hpx.get(T);
          if (b === undefined || h === undefined) counts.noPrice++;
          else if (open.length >= slots) counts.noSlot++;
          else enter(c, T, b.open, h.open);
        }
      }
    }

    if (T < lastT) {
      const crossings: Crossing[] = [];
      for (const s of series) {
        if (held.has(s.coin)) continue;
        const S = spread(s, T);
        const prevRaw = spread(s, T - STEP_MS);
        if (S === null) {
          // Counted only when the coin could have crossed: the previous spread exists and was below the level.
          if (prevRaw !== null && (T === fromT || Math.abs(prevRaw) < level - EPS)) counts.noCoverage++;
          continue;
        }
        if (!(Math.abs(S) >= level - EPS)) continue;
        const prev = prevRaw ?? 0;
        if (T === fromT || Math.abs(prev) < level - EPS) {
          crossings.push({ series: s, sign: S > 0 ? 1 : -1, entryS: S, abs: Math.abs(S) });
        }
      }
      crossings.sort((a, b) => b.abs - a.abs || compareCodeUnits(a.series.coin, b.series.coin));

      if (entryDelaySteps === 1) {
        queue = crossings;
      } else {
        for (const c of crossings) {
          const b = c.series.bpx.get(T);
          const h = c.series.hpx.get(T);
          if (b === undefined || h === undefined) counts.noPrice++;
          else if (open.length >= slots) counts.noSlot++;
          else enter(c, T, b.open, h.open);
        }
      }
    }
  }

  positions.sort((a, b) => a.entryT - b.entryT || compareCodeUnits(a.coin, b.coin));
  return { positions, counts };
}

/** Re-prices a position that was computed at `lockedPerSide` to `perSide`: net + 2 x (lockedPerSide - perSide). */
export function repriceNet(p: Position, perSide: number, lockedPerSide: number): number {
  return p.net + 2 * (lockedPerSide - perSide);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Capital per unit of notional: each leg at 1x on its own venue. */
export const CAPITAL_PER_UNIT = 2;

export function clusterIndex(entryT: number, fromT: number): number {
  return Math.floor((entryT - fromT) / WEEK_MS);
}

export interface BootstrapOpts {
  fromT: number;
  endT: number;
  slots: number;
  capitalPerUnit?: number;
  seed: number;
  resamples?: number;
}

export interface BootstrapResult {
  point: number;
  lo: number;
  hi: number;
  W: number;
  years: number;
  capital: number;
}

/**
 * Cluster bootstrap on the annual return itself. Clusters are the seven-day
 * blocks of [fromT, endT) by entry time. Each resample draws W clusters with
 * floor(rng() x W) from one mulberry32(seed) stream, in order, resample 0 first.
 */
export function clusterBootstrapAnnual(positions: readonly Position[], opts: BootstrapOpts): BootstrapResult {
  const years = (opts.endT - opts.fromT) / YEAR_MS;
  const capital = opts.slots * (opts.capitalPerUnit ?? CAPITAL_PER_UNIT);
  const W = Math.ceil((opts.endT - opts.fromT) / WEEK_MS);
  const resamples = opts.resamples ?? 10000;
  if (!Number.isInteger(resamples) || resamples < 1) throw new Error('resamples must be a positive integer');
  if (W < 1) throw new Error('the span is empty');

  const sums = new Array<number>(W).fill(0);
  let totalNet = 0;
  for (const p of positions) {
    const idx = clusterIndex(p.entryT, opts.fromT);
    if (idx < 0 || idx >= W) throw new Error(`position entry ${p.entryT} is outside the span`);
    sums[idx] += p.net;
    totalNet += p.net;
  }
  const point = totalNet / capital / years;

  const rng = mulberry32(opts.seed);
  const annuals: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < W; i++) sum += sums[Math.floor(rng() * W)];
    annuals.push(sum / capital / years);
  }
  annuals.sort((a, b) => a - b);
  return {
    point,
    lo: quantile(annuals, 0.025) as number,
    hi: quantile(annuals, 0.975) as number,
    W,
    years,
    capital,
  };
}

export interface SummaryOpts extends BootstrapOpts {
  hurdle?: number;
}

export interface PeriodRow {
  n: number;
  sumNet: number;
  returnOnCapital: number;
}

export interface LockedSummary {
  annual: BootstrapResult;
  pass: boolean;
  hurdle: number;
  byHalfYear: Record<string, PeriodRow>;
  byYear: Record<string, PeriodRow>;
  byReason: Record<ExitReason, number>;
  counts: BookResult['counts'];
  distinctCoins: number;
  worst: { net: number; coin: string; entryT: number } | null;
  slotUse: number;
}

function periodRows(
  positions: readonly Position[],
  keyOf: (entryT: number) => string,
  capital: number
): Record<string, PeriodRow> {
  const rows = new Map<string, { n: number; sumNet: number }>();
  for (const p of positions) {
    const key = keyOf(p.entryT);
    const row = rows.get(key) ?? { n: 0, sumNet: 0 };
    row.n++;
    row.sumNet += p.net;
    rows.set(key, row);
  }
  const out: Record<string, PeriodRow> = {};
  for (const key of [...rows.keys()].sort()) {
    const row = rows.get(key)!;
    out[key] = { n: row.n, sumNet: row.sumNet, returnOnCapital: row.sumNet / capital };
  }
  return out;
}

export function summariseLocked(book: BookResult, opts: SummaryOpts): LockedSummary {
  const hurdle = opts.hurdle ?? LOCKED_HURDLE;
  const annual = clusterBootstrapAnnual(book.positions, opts);
  const capital = annual.capital;

  const byReason: Record<ExitReason, number> = { signal: 0, unavailable: 0, end: 0, liquidated: 0 };
  let heldMs = 0;
  let worst: LockedSummary['worst'] = null;
  for (const p of book.positions) {
    byReason[p.reason]++;
    heldMs += p.exitT - p.entryT;
    if (worst === null || p.net < worst.net) worst = { net: p.net, coin: p.coin, entryT: p.entryT };
  }

  return {
    annual,
    pass: annual.point >= hurdle && annual.lo > 0,
    hurdle,
    byHalfYear: periodRows(
      book.positions,
      (t) => {
        const d = new Date(t);
        return `${d.getUTCFullYear()}-H${d.getUTCMonth() < 6 ? 1 : 2}`;
      },
      capital
    ),
    byYear: periodRows(book.positions, (t) => String(new Date(t).getUTCFullYear()), capital),
    byReason,
    counts: book.counts,
    distinctCoins: new Set(book.positions.map((p) => p.coin)).size,
    worst,
    slotUse: heldMs / (opts.slots * (opts.endT - opts.fromT)),
  };
}

export const PROFILES: ReadonlyArray<{ name: string; perSide: number }> = [
  { name: 'locked', perSide: LOCKED_PER_SIDE },
  { name: 'taker', perSide: 0.00155 },
  { name: 'taker+10bps', perSide: 0.00355 },
  { name: 'locked+5bps', perSide: 0.00285 },
];

export interface ProfileOpts {
  fromT: number;
  endT: number;
  slots: number;
  capitalPerUnit?: number;
}

/** The annual point return of the same positions re-priced at each reported cost profile (reporting only). */
export function profileReport(
  book: BookResult,
  opts: ProfileOpts
): Array<{ name: string; perSide: number; annual: number }> {
  const years = (opts.endT - opts.fromT) / YEAR_MS;
  const capital = opts.slots * (opts.capitalPerUnit ?? CAPITAL_PER_UNIT);
  return PROFILES.map(({ name, perSide }) => {
    let total = 0;
    for (const p of book.positions) total += repriceNet(p, perSide, LOCKED_PER_SIDE);
    return { name, perSide, annual: total / capital / years };
  });
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export interface SpanGuardOpts {
  out: string;
  lockFile?: string;
  lockSha256?: string;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A run whose span end is after READ_CUTOFF_MS needs the lock file and its
 * sha256 (lowercase hex) and refuses to run when `<out>.read-done` exists.
 */
export function assertSpanAllowed(endMs: number, opts: SpanGuardOpts): void {
  if (!Number.isFinite(endMs)) throw new Error('span guard: the span end is not a finite number');
  if (endMs <= READ_CUTOFF_MS) return;
  if (opts.lockFile === undefined || opts.lockFile === '') {
    throw new Error(`span guard: span end ${endMs} is after ${READ_CUTOFF_MS} and --lock-file was not given`);
  }
  if (opts.lockSha256 === undefined || opts.lockSha256 === '') {
    throw new Error(`span guard: span end ${endMs} is after ${READ_CUTOFF_MS} and --lock-sha256 was not given`);
  }
  if (!existsSync(opts.lockFile)) throw new Error(`span guard: lock file ${opts.lockFile} does not exist`);
  const actual = sha256Hex(readFileSync(opts.lockFile));
  if (actual !== opts.lockSha256) {
    throw new Error(`span guard: lock file sha256 ${actual} does not equal --lock-sha256 ${opts.lockSha256}`);
  }
  if (existsSync(`${opts.out}.read-done`)) {
    throw new Error(`span guard: ${opts.out}.read-done exists, this span has already been read`);
  }
}

/** Throws when a request's end time is after the span end of the run. */
export function assertRequestEnd(endMs: number, spanEndMs: number): void {
  if (!Number.isFinite(endMs) || !Number.isFinite(spanEndMs) || endMs > spanEndMs) {
    throw new Error(`data discipline: request end ${endMs} is after the run span end ${spanEndMs}`);
  }
}

export function hyperliquidFundingRequest(
  coin: string,
  startTime: number,
  endTime: number,
  spanEndMs: number
): { type: 'fundingHistory'; coin: string; startTime: number; endTime: number } {
  assertRequestEnd(endTime, spanEndMs);
  return { type: 'fundingHistory', coin, startTime, endTime };
}

export function hyperliquidCandleRequest(
  coin: string,
  startTime: number,
  endTime: number,
  spanEndMs: number
): { type: 'candleSnapshot'; req: { coin: string; interval: '8h'; startTime: number; endTime: number } } {
  assertRequestEnd(endTime, spanEndMs);
  return { type: 'candleSnapshot', req: { coin, interval: '8h', startTime, endTime } };
}

/** Archive month labels YYYY-MM from the month of startMs through the month of spanEndMs - 1. */
export function archiveMonthsForSpan(startMs: number, spanEndMs: number): string[] {
  if (spanEndMs <= startMs) return [];
  const first = new Date(startMs);
  const last = new Date(spanEndMs - 1);
  const months: string[] = [];
  let year = first.getUTCFullYear();
  let month = first.getUTCMonth();
  const lastKey = last.getUTCFullYear() * 12 + last.getUTCMonth();
  while (year * 12 + month <= lastKey) {
    assertRequestEnd(Date.UTC(year, month, 1), spanEndMs - 1);
    months.push(`${year}-${String(month + 1).padStart(2, '0')}`);
    month++;
    if (month === 12) {
      month = 0;
      year++;
    }
  }
  return months;
}

// ---------------------------------------------------------------------------
// Parsers (no network, no 2024-06 clamp: the span end is a parameter)
// ---------------------------------------------------------------------------

const KNOWN_GAPS_HOURS = new Set([1, 2, 4, 8]);

/**
 * normaliseSettlements from ./funding-scout with the 2024-06 clamp replaced by
 * the span end (events with t < spanEndMs are kept). Identical output for rows
 * before the old cutoff. The original cannot be reused: it drops every row at or
 * after 2024-07-01.
 */
export function normaliseSettlementsSpan(rows: readonly FundingCsvRow[], spanEndMs: number): ScoutSettlement[] {
  const kept = rows
    .map((row) => ({ t: settlementTimeOf(row.timestamp), row }))
    .filter(({ t }) => t >= SCOUT_FROM_MS && t < spanEndMs)
    .sort((a, b) => a.t - b.t);

  const unique: Array<{ t: number; row: FundingCsvRow }> = [];
  for (const item of kept) {
    if (unique.length > 0 && unique[unique.length - 1].t === item.t) unique[unique.length - 1] = item;
    else unique.push(item);
  }

  return unique.map(({ t, row }, i) => {
    let intervalHours: number;
    if (row.intervalHours !== null && Number.isFinite(row.intervalHours) && row.intervalHours > 0) {
      intervalHours = row.intervalHours;
    } else {
      const gap = i > 0 ? (t - unique[i - 1].t) / HOUR_MS : Number.NaN;
      intervalHours = KNOWN_GAPS_HOURS.has(gap) ? gap : 8;
    }
    return { t, rate: row.rate, intervalHours, r8: (row.rate * 8) / intervalHours };
  });
}

/** Hyperliquid fundingHistory rows: hour-rounded time, the last row of a duplicated hour kept, t <= spanEndMs - 1. */
export function parseHyperliquidFundingSpan(json: unknown, spanEndMs: number): Array<{ t: number; rate: number }> {
  if (!Array.isArray(json)) throw new Error('hyperliquid fundingHistory: expected an array');
  const rows: Array<{ t: number; rate: number }> = [];
  for (const item of json) {
    const r = asRecord(item, 'hyperliquid fundingHistory row');
    const time = toNum(r.time);
    const rate = toNum(r.fundingRate);
    if (!Number.isFinite(time) || !Number.isFinite(rate)) continue;
    const t = settlementTimeOf(time);
    if (t > spanEndMs - 1) continue;
    rows.push({ t, rate });
  }
  return dedupeByHour(rows);
}

/** Hyperliquid 8h candles keyed by open time, open times before spanEndMs only. */
export function parseHyperliquidCandlesSpan(json: unknown, spanEndMs: number): Map<number, PriceBar> {
  if (!Array.isArray(json)) throw new Error('hyperliquid candleSnapshot: expected an array');
  const map = new Map<number, PriceBar>();
  for (const item of json) {
    const r = asRecord(item, 'hyperliquid candleSnapshot row');
    const t = toNum(r.t);
    const open = toNum(r.o);
    const high = toNum(r.h);
    const low = toNum(r.l);
    if (![t, open, high, low].every(Number.isFinite)) continue;
    if (t >= spanEndMs) continue;
    map.set(t, { open, high, low });
  }
  return map;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface LockedArgs {
  universe: string;
  cache: string;
  out: string;
  hlMeta: string;
  fromT: number;
  endT: number;
  coins: string[] | null;
  concurrency: number;
  lockFile?: string;
  lockSha256?: string;
  /** Optional path: write the loaded series (inputs of the book) as JSON, for an independent re-implementation. */
  dumpSeries?: string;
}

const KNOWN_FLAGS = [
  'universe',
  'cache',
  'out',
  'hl-meta',
  'from',
  'end',
  'coins',
  'concurrency',
  'lock-file',
  'lock-sha256',
  'dump-series',
];

function parseUtcFlag(flags: ReadonlyMap<string, string>, name: string): number {
  const raw = flags.get(name);
  if (raw === undefined) throw new Error(`--${name} is required`);
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`--${name} must be an ISO date`);
  if (ms % DAY_MS !== 0) throw new Error(`--${name} must be aligned to UTC midnight`);
  return ms;
}

export function parseLockedArgs(argv: string[]): LockedArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument ${flag}`);
    const key = flag.slice(2);
    if (!KNOWN_FLAGS.includes(key)) throw new Error(`Unknown flag ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    flags.set(key, value);
    i++;
  }
  for (const required of ['universe', 'cache', 'out', 'hl-meta', 'from', 'end']) {
    if (!flags.has(required)) throw new Error(`--${required} is required`);
  }
  const fromT = parseUtcFlag(flags, 'from');
  const endT = parseUtcFlag(flags, 'end');
  if (endT <= fromT) throw new Error('--end must be after --from');
  if ((endT - fromT) % STEP_MS !== 0) throw new Error('--end minus --from must be a multiple of 8 hours');
  const concurrencyRaw = flags.get('concurrency');
  const concurrency = concurrencyRaw === undefined ? 3 : Number(concurrencyRaw);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer');
  return {
    universe: flags.get('universe')!,
    cache: flags.get('cache')!,
    out: flags.get('out')!,
    hlMeta: flags.get('hl-meta')!,
    fromT,
    endT,
    coins: flags.has('coins')
      ? flags
          .get('coins')!
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : null,
    concurrency,
    ...(flags.has('lock-file') ? { lockFile: flags.get('lock-file')! } : {}),
    ...(flags.has('lock-sha256') ? { lockSha256: flags.get('lock-sha256')! } : {}),
    ...(flags.has('dump-series') ? { dumpSeries: flags.get('dump-series')! } : {}),
  };
}

/** Serialises Hyperliquid requests so the shared client's throttle holds when coins load concurrently. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

interface LoadContext {
  cacheRoot: string;
  client: ApiClient;
  queue: SerialQueue;
  fromT: number;
  spanEndMs: number;
}

async function hyperliquidJson(ctx: LoadContext, cacheFile: string, body: unknown): Promise<unknown> {
  return ctx.queue.run(() => ctx.client.getJson(cacheFile, HYPERLIQUID_URL, postInit(body)));
}

/** Pages Hyperliquid fundingHistory forward; returns the combined raw rows. */
async function fetchFundingRows(coin: string, ctx: LoadContext): Promise<unknown[]> {
  const end = ctx.spanEndMs - 1;
  let start = ctx.spanEndMs <= READ_CUTOFF_MS ? SCOUT_FROM_MS : ctx.fromT - 3 * DAY_MS;
  const all: unknown[] = [];
  for (;;) {
    const body = hyperliquidFundingRequest(coin, start, end, ctx.spanEndMs);
    const json = await hyperliquidJson(
      ctx,
      join(ctx.cacheRoot, 'hyperliquid', 'funding', safeName(coin), `${start}-${end}.json`),
      body
    );
    if (!Array.isArray(json)) throw new Error('hyperliquid fundingHistory: expected an array');
    if (json.length === 0) break;
    all.push(...json);
    const lastTime = toNum(asRecord(json[json.length - 1], 'hyperliquid fundingHistory row').time);
    if (!Number.isFinite(lastTime)) throw new Error('hyperliquid fundingHistory: last row has no time');
    if (lastTime >= ctx.spanEndMs - HOUR_MS) break;
    start = lastTime + 1;
    if (start > end) break;
  }
  return all;
}

/** Pages Hyperliquid 8h candleSnapshot forward; returns the combined raw rows. */
async function fetchCandleRows(coin: string, ctx: LoadContext): Promise<unknown[]> {
  const end = ctx.spanEndMs - 1;
  let start = ctx.fromT - 3 * DAY_MS;
  const all: unknown[] = [];
  for (;;) {
    const body = hyperliquidCandleRequest(coin, start, end, ctx.spanEndMs);
    const json = await hyperliquidJson(
      ctx,
      join(ctx.cacheRoot, 'hyperliquid', 'candles', safeName(coin), `${start}-${end}.json`),
      body
    );
    if (!Array.isArray(json)) throw new Error('hyperliquid candleSnapshot: expected an array');
    if (json.length === 0) break;
    all.push(...json);
    const lastTime = toNum(asRecord(json[json.length - 1], 'hyperliquid candleSnapshot row').t);
    if (!Number.isFinite(lastTime)) throw new Error('hyperliquid candleSnapshot: last row has no open time');
    if (lastTime >= end) break;
    start = lastTime + CANDLE_MS;
    if (start > end) break;
  }
  return all;
}

async function loadBinance(
  symbol: string,
  ctx: LoadContext
): Promise<{ bf: BinanceEvent[]; bpx: Map<number, PriceBar> }> {
  const months = archiveMonthsForSpan(ctx.fromT - 3 * DAY_MS, ctx.spanEndMs);
  const cacheDir = join(ctx.cacheRoot, 'archive');
  const fundingRows: FundingCsvRow[] = [];
  const bpx = new Map<number, PriceBar>();
  for (const month of months) {
    const funding = await fetchArchiveFile({ dataset: 'fundingRate', symbol, date: month }, { cacheDir });
    if (funding !== null) fundingRows.push(...parseFundingCsv(funding));
    const klines = await fetchArchiveFile({ dataset: 'klines', symbol, interval: '1h', date: month }, { cacheDir });
    if (klines !== null) {
      for (const row of parseKlineCsv(klines)) {
        if (row.timestamp >= ctx.spanEndMs) continue;
        bpx.set(row.timestamp, { open: row.open, high: row.high, low: row.low });
      }
    }
  }
  const bf = normaliseSettlementsSpan(fundingRows, ctx.spanEndMs).map((s) => ({
    t: s.t,
    rate: s.rate,
    intervalHours: s.intervalHours,
  }));
  return { bf, bpx };
}

async function runPool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (failure === null) {
      const index = next++;
      if (index >= items.length) return;
      try {
        await fn(items[index]);
      } catch (error) {
        failure = failure ?? error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (failure !== null) throw failure;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseLockedArgs(argv);
  // The guard runs before any file is read or any request is made.
  assertSpanAllowed(args.endT, { out: args.out, lockFile: args.lockFile, lockSha256: args.lockSha256 });

  const universe = JSON.parse(readFileSync(args.universe, 'utf8')) as UniverseSource;
  const metaBytes = readFileSync(args.hlMeta);
  const listed = new Set(parseHyperliquidMeta(JSON.parse(metaBytes.toString('utf8'))));

  const folders = universe.folders
    .filter((f) => f.include && f.fundingMonths.length >= 1)
    .sort((a, b) => compareCodeUnits(a.name, b.name));
  const matched: Array<{ folder: UniverseFolder; coin: string }> = [];
  const unmatched: string[] = [];
  const skipped: Array<{ coin: string; symbol: string; reason: string }> = [];
  const seenCoins = new Set<string>();
  for (const folder of folders) {
    const coin = hyperliquidCoinFor(folder.name, listed);
    if (coin === null) {
      unmatched.push(folder.name);
      continue;
    }
    if (args.coins !== null && !args.coins.includes(coin)) continue;
    if (seenCoins.has(coin)) {
      skipped.push({ coin, symbol: folder.name, reason: 'duplicate Hyperliquid coin' });
      continue;
    }
    seenCoins.add(coin);
    matched.push({ folder, coin });
  }
  console.error(`venue-spread-locked: ${matched.length} matched, ${unmatched.length} unmatched`);

  const ctx: LoadContext = {
    cacheRoot: args.cache,
    client: new ApiClient(fetch, 1_500),
    queue: new SerialQueue(),
    fromT: args.fromT,
    spanEndMs: args.endT,
  };

  const loaded = new Map<string, CoinSeries>();
  let done = 0;
  await runPool(matched, args.concurrency, async ({ folder, coin }) => {
    const fundingRows = parseHyperliquidFundingSpan(await fetchFundingRows(coin, ctx), args.endT);
    if (fundingRows.length === 0) {
      skipped.push({ coin, symbol: folder.name, reason: 'no Hyperliquid funding' });
      return;
    }
    const hpx = parseHyperliquidCandlesSpan(await fetchCandleRows(coin, ctx), args.endT);
    if (hpx.size === 0) {
      skipped.push({ coin, symbol: folder.name, reason: 'no Hyperliquid candles' });
      return;
    }
    const { bf, bpx } = await loadBinance(folder.name, ctx);
    loaded.set(coin, { coin, symbol: folder.name, bf, hf: fundingRows, bpx, hpx });
    done++;
    if (done % 10 === 0) console.error(`venue-spread-locked: ${done}/${matched.length} coins`);
  });

  const series = [...loaded.values()].sort((a, b) => compareCodeUnits(a.coin, b.coin));
  skipped.sort((a, b) => compareCodeUnits(a.coin, b.coin));
  const lastT = args.endT - STEP_MS;
  const base = {
    fromT: args.fromT,
    lastT,
    slots: LOCKED_SLOTS,
    level: LOCKED_LEVEL,
    perSide: LOCKED_PER_SIDE,
  };
  if (args.dumpSeries !== undefined) {
    const pxObject = (m: ReadonlyMap<number, PriceBar>): Record<string, number[]> =>
      Object.fromEntries([...m.entries()].map(([t, b]) => [String(t), [b.open, b.high, b.low]]));
    writeFileSync(
      args.dumpSeries,
      JSON.stringify({
        fromT: args.fromT,
        lastT,
        level: LOCKED_LEVEL,
        perSide: LOCKED_PER_SIDE,
        slots: LOCKED_SLOTS,
        series: series.map((x) => ({ coin: x.coin, symbol: x.symbol, bf: x.bf, hf: x.hf, bpx: pxObject(x.bpx), hpx: pxObject(x.hpx) })),
      })
    );
  }
  const delay0 = simulateBook(series, { ...base, entryDelaySteps: 0 });
  const delay1 = simulateBook(series, { ...base, entryDelaySteps: 1 });
  const statOpts: SummaryOpts = {
    fromT: args.fromT,
    endT: args.endT,
    slots: LOCKED_SLOTS,
    seed: LOCKED_SEED,
    hurdle: LOCKED_HURDLE,
  };
  const profileOpts: ProfileOpts = { fromT: args.fromT, endT: args.endT, slots: LOCKED_SLOTS };

  const lockSha256 =
    args.lockSha256 ?? (args.lockFile !== undefined && existsSync(args.lockFile) ? sha256Hex(readFileSync(args.lockFile)) : null);
  const report = {
    params: {
      lockSha256,
      universeSha256: universe.sha256,
      metaSha256: sha256Hex(metaBytes),
      from: args.fromT,
      end: args.endT,
      fromIso: new Date(args.fromT).toISOString(),
      endIso: new Date(args.endT).toISOString(),
      lastT,
      slots: LOCKED_SLOTS,
      level: LOCKED_LEVEL,
      perSide: LOCKED_PER_SIDE,
      seed: LOCKED_SEED,
      hurdle: LOCKED_HURDLE,
    },
    coins: { matched: matched.length, unmatched, simulated: series.length, skipped },
    books: { delay0, delay1 },
    summary: { delay0: summariseLocked(delay0, statOpts), delay1: summariseLocked(delay1, statOpts) },
    profiles: { delay0: profileReport(delay0, profileOpts), delay1: profileReport(delay1, profileOpts) },
  };
  writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  if (args.endT > READ_CUTOFF_MS) {
    writeFileSync(`${args.out}.read-done`, `${lockSha256 ?? ''}\n${new Date().toISOString()}\n`);
  }

  const judged = report.summary.delay0;
  console.log(
    [
      `positions ${delay0.positions.length}`,
      `annual ${judged.annual.point.toFixed(4)}`,
      `ci [${judged.annual.lo.toFixed(4)}, ${judged.annual.hi.toFixed(4)}]`,
      `pass ${judged.pass}`,
      `slotUse ${judged.slotUse.toFixed(3)}`,
    ].join(' | ')
  );
  console.error(`venue-spread-locked: report ${args.out}`);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
