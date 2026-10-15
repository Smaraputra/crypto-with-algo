/**
 * The 8h perp panel for the rv-v1 re-validation (header DATA and AMENDMENTS 1 and 2 in
 * scripts/research/rv-revalidation.ts).
 *
 * 4h perp klines are paired into 8h bars at 00, 08 and 16 UTC, each bar carries the funding settled in
 * (bar open, bar close], the ten symbols share one rectangular grid, and the 8h bars are rebuilt from the
 * 1h klines as a cross-check. Every HALT rule of the header and its amendments throws here, so a panel
 * that comes back is one the study may use.
 *
 * Panel end (AMENDMENT 1): the last bar is the last one whose funding window (open, open + 8h] closes
 * inside the export span. The export stops at 2026-10-13T23:59:59.999Z, so the settlement at
 * 2026-10-14 00:00 is not in it and the 16:00 bar of the final day is left out of the grid rather than
 * carried with a partial sum, which a permutation would otherwise move into the middle of the panel.
 *
 * Funding flags (AMENDMENTS 1 to 3): a settlement the coverage check expects but the rows lack, and every
 * interval switch derived from null-interval spacing, is a flag. A flag is cleared only by an exact
 * `no-event` entry of a resolutions file that passed the REST re-check in this run (verifyResolutions in
 * rv-resolutions.ts), and only if the entry's recorded neighbours are the export's own settlements either
 * side. A cleared flag adds nothing to fundSum, and a bar it leaves with no carry input halts.
 */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import type { OHLCV } from '@/types/market';
import { RV_V1 } from '@/lib/signals/cross-sectional/engine';
import { missingSettlements } from './broad-inputs';
import { stableStringify } from './broad-trend';
import { datasetHashOf, type DatasetKind, type FundingRow, type ManifestFile, type PerpCandleRow } from './dataset-format';
import { loadManifest, parseJsonlGz } from './load-dataset';
import { assertVerified, type VerifiedResolutions } from './rv-resolutions';
import { fundingSumsFor } from './strategy-walk-forward';

const HOUR_MS = 3_600_000;
const H4_MS = 4 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;
const BAR_MS = RV_V1.barMs;

/** The header's universe, in the header's order. BTCUSDT first is the beta anchor. */
export const RV_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'LINKUSDT',
] as const;

/** The header's export span: start 2022-01-01T00:00:00Z, end 2026-10-13T23:59:59.999Z. */
export const RV_SPAN: Span = { from: Date.UTC(2022, 0, 1), to: Date.UTC(2026, 9, 13, 23, 59, 59, 999) };

/** AMENDMENT 2: HALT on any dropped bucket (it replaced the header's "more than 3"). */
export const MAX_DROPPED_BUCKETS = 0;

/** Header: the 1h cross-check tolerates a relative 1e-7 in volume and taker-buy volume, nothing in OHLC. */
export const VOLUME_REL_TOL = 1e-7;

/** The funding intervals Binance uses, in hours. A derived interval must be one of them. */
const FUNDING_INTERVALS_H = new Set([1, 2, 4, 8]);

export interface Span {
  from: number;
  to: number;
}

export interface Bar8h {
  /** Bar open, ms UTC, on an 8h boundary. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Null when either 4h half had no taker-buy volume. The panel halts on it. */
  tbv: number | null;
}

/** Columns are [symbol][bar]. `t` holds the bar open times. */
export interface RvPanel {
  symbols: string[];
  t: number[];
  open: number[][];
  high: number[][];
  low: number[][];
  close: number[][];
  volume: number[][];
  tbv: number[][];
  /** Sum of the settled rates in (bar open, bar close]. */
  fundSum: number[][];
  /** The latest settled rate in (bar close - 8h, bar close], null when none settled there. */
  fundLast: (number | null)[][];
}

export interface RvSymbolSource {
  symbol: string;
  rows4h: PerpCandleRow[];
  rows1h: PerpCandleRow[];
  funding: FundingRow[];
}

export interface DroppedBucket {
  symbol: string;
  t: number;
}

export interface PanelMismatch {
  symbol: string;
  t: number;
  field: 'open' | 'high' | 'low' | 'close' | 'volume' | 'tbv' | 'missing';
  from4h: number | null;
  from1h: number | null;
}

/**
 * A settlement instant that needs a REST-verified resolution. `missing`: the coverage check expects a
 * settlement the rows lack. `derived-switch`: an instant on the shorter interval's grid inside the longer
 * gap next to an interval switch derived from null-interval spacing (AMENDMENT 2).
 */
export interface FundingFlag {
  symbol: string;
  t: number;
  reason: 'missing' | 'derived-switch';
}

/**
 * One entry of the recorded resolutions file (AMENDMENT 1). Only `no-event` clears a flag: Binance REST has
 * no settlement for the symbol at `t`, and its nearest settlements either side are `restBefore` and
 * `restAfter`. Any other verdict halts.
 */
export interface ResolutionEntry {
  symbol: string;
  t: number;
  verdict: string;
  restBefore: number;
  restAfter: number;
}

/** A resolutions file as parseResolutions reads it: the sha256 of its bytes and its entries. The panel takes only VerifiedResolutions, which verifyResolutions builds from the file bytes. */
export interface FundingResolutions {
  sha256: string;
  entries: ResolutionEntry[];
}

/** What the panel records about the resolutions it used (into RESULT). */
export interface ResolutionsRecord {
  sha256: string;
  entries: number;
  /** Every flag, each cleared by exactly one entry. */
  flags: FundingFlag[];
}

const iso = (t: number) => new Date(t).toISOString();

const finitePositive = (x: number) => Number.isFinite(x) && x > 0;
const finiteNonNegative = (x: number) => Number.isFinite(x) && x >= 0;

/**
 * Kline halts: a non-finite or non-positive open, high, low or close, a non-finite or non-positive volume,
 * a negative or non-finite taker-buy volume (AMENDMENT 2), and a taker-buy volume above the volume
 * (AMENDMENT 3). A null taker-buy volume passes here and halts in assemblePanel.
 */
function assertKline(row: PerpCandleRow, label: string): void {
  if (![row.o, row.h, row.l, row.c].every(finitePositive)) {
    throw new Error(`HALT: ${label} row at ${iso(row.t)} has a non-finite or non-positive price`);
  }
  if (!finitePositive(row.v) || (row.tbv !== null && !finiteNonNegative(row.tbv))) {
    throw new Error(`HALT: ${label} row at ${iso(row.t)} has a zero, negative or non-finite volume or taker-buy volume`);
  }
  if (row.tbv !== null && row.tbv > row.v) {
    throw new Error(`HALT: ${label} row at ${iso(row.t)} has a taker-buy volume ${row.tbv} above its volume ${row.v}`);
  }
}

/**
 * The 8h bar opens of a span: from the span start to the last bar whose close (open + 8h) is inside the
 * span, so every bar's funding window is covered by the export.
 */
export function panelGrid(span: Span): Span {
  if (span.from % BAR_MS !== 0) throw new Error(`The span must start on an 8h boundary, got ${iso(span.from)}`);
  const to = Math.floor((span.to - BAR_MS) / BAR_MS) * BAR_MS;
  if (to < span.from) throw new Error(`The span ${iso(span.from)} to ${iso(span.to)} holds no complete 8h bar`);
  return { from: span.from, to };
}

/**
 * Pairs 4h rows into 8h bars for every bucket open in [grid.from, grid.to]: open of the first half, max
 * high, min low, close of the second half, volume and taker-buy volume summed. A bucket missing either
 * half (or both) is dropped and listed. Rows outside the grid are ignored for pairing but still validated.
 */
export function pairTo8h(rows4h: readonly PerpCandleRow[], grid: Span): { bars: Bar8h[]; dropped: number[] } {
  if (grid.from % BAR_MS !== 0 || grid.to % BAR_MS !== 0 || grid.to < grid.from) {
    throw new Error(`The pairing grid must run between 8h boundaries, got ${iso(grid.from)} to ${iso(grid.to)}`);
  }
  const byOpen = new Map<number, PerpCandleRow>();
  for (const row of rows4h) {
    if (row.t % H4_MS !== 0) throw new Error(`HALT: a 4h row at ${iso(row.t)} is off the 4h grid`);
    if (byOpen.has(row.t)) throw new Error(`HALT: duplicate 4h row at ${iso(row.t)}`);
    assertKline(row, '4h');
    byOpen.set(row.t, row);
  }
  const bars: Bar8h[] = [];
  const dropped: number[] = [];
  for (let b = grid.from; b <= grid.to; b += BAR_MS) {
    const first = byOpen.get(b);
    const second = byOpen.get(b + H4_MS);
    if (!first || !second) {
      dropped.push(b);
      continue;
    }
    bars.push({
      t: b,
      open: first.o,
      high: Math.max(first.h, second.h),
      low: Math.min(first.l, second.l),
      close: second.c,
      volume: first.v + second.v,
      tbv: first.tbv === null || second.tbv === null ? null : first.tbv + second.tbv,
    });
  }
  return { bars, dropped };
}

/**
 * Per 8h bar: the sum of the settled rates in (open, close] (fundingSumsFor, the convention the other
 * studies share), how many settled there, and the latest of them (null when none).
 */
export function fundingPerBar(
  bars: readonly Bar8h[],
  settlements: ReadonlyArray<{ t: number; rate: number }>
): { fundSum: number[]; fundLast: (number | null)[]; fundCount: number[] } {
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].t <= bars[i - 1].t) throw new Error('fundingPerBar needs bars in strictly increasing time order');
  }
  const candles: OHLCV[] = bars.map((b) => ({
    timestamp: b.t,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
  const fundSum = Array.from(fundingSumsFor(candles, BAR_MS, settlements));
  const sorted = [...settlements].sort((a, b) => a.t - b.t);
  const fundLast: (number | null)[] = [];
  const fundCount: number[] = [];
  let p = 0;
  for (const bar of bars) {
    while (p < sorted.length && sorted[p].t <= bar.t) p++;
    let k = p;
    let last: number | null = null;
    while (k < sorted.length && sorted[k].t <= bar.t + BAR_MS) {
      last = sorted[k].rate;
      k++;
    }
    fundLast.push(last);
    fundCount.push(k - p);
  }
  return { fundSum, fundLast, fundCount };
}

/**
 * Fills a null intervalHours (rows written by the REST sync) from the spacing of consecutive settlements,
 * and reports which rows were derived. Each gap is accepted as the interval in force when it is a Binance
 * interval (1, 2, 4 or 8 hours) and equals the gap before or after it. Otherwise the gap is judged at the
 * smallest neighbouring gap that is a Binance interval, so a lone long gap is flagged by
 * missingSettlements. A row takes the interval of the gap that ends at it, and the first row takes the
 * first gap's. Every switch this produces is itself flagged by fundingFlags (AMENDMENT 2), so a missing
 * settlement next to a switch cannot pass as the switch, and a stretch of missing settlements is caught at
 * the switches that bound it. Remaining blind spot: a null-interval series spaced at a multiple of its true
 * interval throughout, with no switch and no stated-interval row beside it, reads as a clean series.
 */
export function deriveIntervals(symbol: string, sorted: readonly FundingRow[]): { rows: FundingRow[]; derived: boolean[] } {
  const derived = sorted.map((r) => r.intervalHours === null);
  if (!derived.some(Boolean)) return { rows: [...sorted], derived };
  if (sorted.length < 2) {
    throw new Error(`HALT: ${symbol} has a settlement without intervalHours and no spacing to derive the interval from`);
  }
  const gaps: number[] = [];
  for (let k = 0; k + 1 < sorted.length; k++) gaps.push((sorted[k + 1].t - sorted[k].t) / HOUR_MS);
  const fromGap = (k: number): number => {
    const g = gaps[k];
    const neighbours = [gaps[k - 1], gaps[k + 1]].filter((x): x is number => x !== undefined);
    if (FUNDING_INTERVALS_H.has(g) && neighbours.includes(g)) return g;
    const candidates = neighbours.filter((x) => FUNDING_INTERVALS_H.has(x));
    if (candidates.length > 0) return Math.min(...candidates);
    if (FUNDING_INTERVALS_H.has(g)) return g;
    throw new Error(
      `HALT: ${symbol}: the funding interval cannot be derived around ${iso(sorted[k + 1].t)} (gap ${g}h, neighbours ${neighbours.join(', ')}h)`
    );
  };
  return {
    rows: sorted.map((row, i) => (row.intervalHours !== null ? row : { ...row, intervalHours: fromGap(Math.max(0, i - 1)) })),
    derived,
  };
}

/**
 * The instants an interval switch derived from null-interval spacing leaves unverified (AMENDMENT 2): at
 * a switch between rows i - 1 and i where either interval was derived, every instant on the shorter
 * interval's grid strictly inside the longer interval's gap next to the switch (the gap ending at row i - 1
 * for a shortening, the gap ending at row i for a lengthening). If the shorter interval was already, or
 * still, in force across that gap, a settlement is missing there, and only REST can tell.
 */
function derivedSwitchInstants(rows: readonly FundingRow[], derived: readonly boolean[], window: Span): number[] {
  const out: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (!derived[i] && !derived[i - 1]) continue;
    const prev = rows[i - 1].intervalHours as number;
    const cur = rows[i].intervalHours as number;
    if (prev === cur) continue;
    const step = Math.min(prev, cur) * HOUR_MS;
    let gap: [number, number] | null = null;
    if (cur > prev) gap = [rows[i - 1].t, rows[i].t];
    else if (i >= 2) gap = [rows[i - 2].t, rows[i - 1].t];
    if (!gap) continue;
    for (let t = gap[0] + step; t < gap[1]; t += step) if (t > window.from && t <= window.to) out.push(t);
  }
  return out;
}

/**
 * Every settlement instant in (window.from, window.to] that needs a REST-verified resolution: settlements
 * the coverage check expects but the rows lack (missingSettlements, each gap judged by its later row's
 * interval as in A6-1, the grid extended back to window.from and forward to window.to), and the instants
 * next to every derived interval switch. HALT, with no resolution possible, on no settlement at all or none
 * inside the window, a duplicate, a time off the hour, a non-finite rate, or an interval that cannot be
 * derived. Rows outside the window only serve as spacing neighbours.
 */
export function fundingFlags(symbol: string, rows: readonly FundingRow[], window: Span): FundingFlag[] {
  if (rows.length === 0) throw new Error(`HALT: ${symbol} has no settlement at all`);
  for (const r of rows) {
    if (r.t % HOUR_MS !== 0) throw new Error(`HALT: ${symbol} settlement at ${iso(r.t)} is not on an hour boundary`);
    if (!Number.isFinite(r.rate)) throw new Error(`HALT: ${symbol} settlement at ${iso(r.t)} has a non-finite rate`);
  }
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t === sorted[i - 1].t) throw new Error(`HALT: ${symbol} has a duplicate settlement at ${iso(sorted[i].t)}`);
  }
  const { rows: withIntervals, derived } = deriveIntervals(symbol, sorted);
  const inWindow = withIntervals.filter((r) => r.t > window.from && r.t <= window.to);
  if (inWindow.length === 0) throw new Error(`HALT: ${symbol} has no settlement inside ${iso(window.from)} to ${iso(window.to)}`);

  // missingSettlements works in days: settlements in (d, d + 1 day] are due on day d. Every day touched by
  // the window is checked, the backward extension stops at firstDay + 1 day = window.from, and its
  // lockbox bound ends the forward extension at window.to (lifeEnd = min(lastDay + 1 day, lockbox - 1)).
  const firstDayChecked = Math.floor(window.from / DAY_MS) * DAY_MS;
  const lastDayChecked = Math.floor((window.to - 1) / DAY_MS) * DAY_MS;
  const checkDays = new Set<number>();
  for (let d = firstDayChecked; d <= lastDayChecked; d += DAY_MS) checkDays.add(d);
  const contract = { id: symbol, firstDay: window.from - DAY_MS, lastDay: Math.floor(window.to / DAY_MS) * DAY_MS, endDay: null };
  const found = missingSettlements(contract, inWindow, checkDays, window.to + 1);
  const unresolvable = found.filter((m) => m.reason !== 'missing');
  if (unresolvable.length > 0) {
    throw new Error(`HALT: ${symbol} funding cannot be checked: ${unresolvable.map((m) => `${iso(m.t)} (${m.reason})`).join(', ')}`);
  }

  const byT = new Map<number, FundingFlag>();
  for (const m of found) byT.set(m.t, { symbol, t: m.t, reason: 'missing' });
  for (const t of derivedSwitchInstants(withIntervals, derived, window)) {
    if (!byT.has(t)) byT.set(t, { symbol, t, reason: 'derived-switch' });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * Matches verified resolutions to the flags (AMENDMENTS 1 and 3). HALT on resolutions verifyResolutions did
 * not return in this run, on a duplicate entry, on a flag with no exact (symbol, t) entry, on an entry that
 * matches no flag, and on an entry whose recorded neighbours are not the export's own nearest settlements
 * before and after the instant. With verifyResolutions having matched the same neighbours on REST, the
 * export and the venue then agree on the settlements bracketing the no-event instant. Verified entries
 * all carry the `no-event` verdict, because verifyResolutions halts on any other.
 */
export function resolveFlags(
  flags: readonly FundingFlag[],
  resolutions: VerifiedResolutions,
  funding: Readonly<Record<string, readonly { t: number }[]>>
): ResolutionsRecord {
  assertVerified(resolutions);
  const key = (symbol: string, t: number) => `${symbol}|${t}`;
  const entries = new Map<string, ResolutionEntry>();
  for (const e of resolutions.entries) {
    if (entries.has(key(e.symbol, e.t))) throw new Error(`HALT: duplicate resolution entry ${e.symbol} ${iso(e.t)}`);
    entries.set(key(e.symbol, e.t), e);
  }
  const unresolved = flags.filter((f) => !entries.has(key(f.symbol, f.t)));
  if (unresolved.length > 0) {
    const listed = unresolved.slice(0, 20).map((f) => `${f.symbol} ${iso(f.t)} (${f.reason})`);
    throw new Error(
      `HALT: ${unresolved.length} flagged funding settlement(s) have no resolution entry (AMENDMENT 1): ${listed.join(', ')}${unresolved.length > 20 ? ', ...' : ''}`
    );
  }
  const flagged = new Set(flags.map((f) => key(f.symbol, f.t)));
  const unused = resolutions.entries.filter((e) => !flagged.has(key(e.symbol, e.t)));
  if (unused.length > 0) {
    throw new Error(`HALT: ${unused.length} resolution entr${unused.length === 1 ? 'y' : 'ies'} matches no flag: ${unused.map((e) => `${e.symbol} ${iso(e.t)}`).join(', ')}`);
  }
  for (const e of resolutions.entries) {
    const times = (funding[e.symbol] ?? []).map((r) => r.t);
    const before = times.filter((t) => t < e.t);
    const after = times.filter((t) => t > e.t);
    const exportBefore = before.length > 0 ? Math.max(...before) : null;
    const exportAfter = after.length > 0 ? Math.min(...after) : null;
    if (exportBefore !== e.restBefore || exportAfter !== e.restAfter) {
      const at = (t: number | null) => (t === null ? 'none' : iso(t));
      throw new Error(
        `HALT: the export's settlements either side of ${e.symbol} ${iso(e.t)} are ${at(exportBefore)} and ${at(exportAfter)}, the entry records ${iso(e.restBefore)} and ${iso(e.restAfter)} (AMENDMENT 3)`
      );
    }
  }
  return { sha256: resolutions.sha256, entries: resolutions.entries.length, flags: [...flags] };
}

export interface SymbolSeries {
  symbol: string;
  bars: Bar8h[];
  fundSum: number[];
  fundLast: (number | null)[];
}

/**
 * The rectangular panel: only the bar opens every symbol carries, in time order (the shared-grid
 * intersection of exposure-walk-forward.ts). A timestamp some symbols lack is not forward-filled.
 */
export function alignPanel(series: readonly SymbolSeries[]): { panel: RvPanel; droppedTimestamps: number[] } {
  const index = series.map((s) => {
    if (s.fundSum.length !== s.bars.length || s.fundLast.length !== s.bars.length) {
      throw new Error(`${s.symbol}: funding columns do not match the bars`);
    }
    const map = new Map<number, number>();
    s.bars.forEach((b, i) => map.set(b.t, i));
    return map;
  });
  const union = [...new Set(series.flatMap((s) => s.bars.map((b) => b.t)))].sort((a, b) => a - b);
  const t = union.filter((x) => index.every((map) => map.has(x)));
  const kept = new Set(t);
  const droppedTimestamps = union.filter((x) => !kept.has(x));

  const panel: RvPanel = {
    symbols: series.map((s) => s.symbol),
    t,
    open: [],
    high: [],
    low: [],
    close: [],
    volume: [],
    tbv: [],
    fundSum: [],
    fundLast: [],
  };
  series.forEach((s, si) => {
    const rows = t.map((x) => index[si].get(x) as number);
    const bars = rows.map((i) => s.bars[i]);
    panel.open.push(bars.map((b) => b.open));
    panel.high.push(bars.map((b) => b.high));
    panel.low.push(bars.map((b) => b.low));
    panel.close.push(bars.map((b) => b.close));
    panel.volume.push(bars.map((b) => b.volume));
    panel.tbv.push(
      bars.map((b) => {
        if (b.tbv === null) throw new Error(`HALT: ${s.symbol} has a null taker-buy volume at ${iso(b.t)}`);
        return b.tbv;
      })
    );
    panel.fundSum.push(rows.map((i) => s.fundSum[i]));
    panel.fundLast.push(rows.map((i) => s.fundLast[i]));
  });
  return { panel, droppedTimestamps };
}

const relDiff = (a: number, b: number) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)));

/**
 * Rebuilds every panel bar from eight 1h rows and compares: open, high, low and close must be equal, volume
 * and taker-buy volume within a relative VOLUME_REL_TOL. A bar the 1h series cannot rebuild is a mismatch
 * ('missing'), as is a null 1h taker-buy volume ('tbv'). HALT on a duplicate or off-hour 1h row and on an
 * invalid 1h price or volume (AMENDMENT 2).
 */
export function crossCheck1h(panel: RvPanel, rows1h: Readonly<Record<string, readonly PerpCandleRow[]>>): PanelMismatch[] {
  const out: PanelMismatch[] = [];
  panel.symbols.forEach((symbol, si) => {
    const byOpen = new Map<number, PerpCandleRow>();
    for (const r of rows1h[symbol] ?? []) {
      if (r.t % HOUR_MS !== 0) throw new Error(`HALT: ${symbol} 1h row at ${iso(r.t)} is not on an hour boundary`);
      if (byOpen.has(r.t)) throw new Error(`HALT: ${symbol} has a duplicate 1h row at ${iso(r.t)}`);
      assertKline(r, `${symbol} 1h`);
      byOpen.set(r.t, r);
    }
    panel.t.forEach((t, k) => {
      const hours: PerpCandleRow[] = [];
      for (let j = 0; j < 8; j++) {
        const r = byOpen.get(t + j * HOUR_MS);
        if (r) hours.push(r);
      }
      if (hours.length !== 8) {
        out.push({ symbol, t, field: 'missing', from4h: null, from1h: null });
        return;
      }
      const rebuilt = {
        open: hours[0].o,
        high: Math.max(...hours.map((r) => r.h)),
        low: Math.min(...hours.map((r) => r.l)),
        close: hours[7].c,
      };
      for (const field of ['open', 'high', 'low', 'close'] as const) {
        if (panel[field][si][k] !== rebuilt[field]) {
          out.push({ symbol, t, field, from4h: panel[field][si][k], from1h: rebuilt[field] });
        }
      }
      const volume = hours.reduce((s, r) => s + r.v, 0);
      if (relDiff(panel.volume[si][k], volume) > VOLUME_REL_TOL) {
        out.push({ symbol, t, field: 'volume', from4h: panel.volume[si][k], from1h: volume });
      }
      if (hours.some((r) => r.tbv === null)) {
        out.push({ symbol, t, field: 'tbv', from4h: panel.tbv[si][k], from1h: null });
      } else {
        const tbv = hours.reduce((s, r) => s + (r.tbv as number), 0);
        if (relDiff(panel.tbv[si][k], tbv) > VOLUME_REL_TOL) {
          out.push({ symbol, t, field: 'tbv', from4h: panel.tbv[si][k], from1h: tbv });
        }
      }
    });
  });
  return out;
}

/** The first 1h bar of each panel bar ([symbol][bar]), the maker track's fill bars (Task 7B addendum rule 10). */
export interface FirstHourBars {
  open: number[][];
  high: number[][];
  low: number[][];
  close: number[][];
}

/**
 * The 1h row opening at each panel bar's open, per symbol. On a panel that passed crossCheck1h every row exists and
 * its open is the bar's open. HALT if one is missing.
 */
export function firstHourBars(panel: RvPanel, rows1h: Readonly<Record<string, readonly PerpCandleRow[]>>): FirstHourBars {
  const out: FirstHourBars = { open: [], high: [], low: [], close: [] };
  for (const symbol of panel.symbols) {
    const byOpen = new Map((rows1h[symbol] ?? []).map((r) => [r.t, r]));
    const rows = panel.t.map((t) => {
      const r = byOpen.get(t);
      if (!r) throw new Error(`HALT: ${symbol} has no 1h row at the panel bar open ${iso(t)}`);
      return r;
    });
    out.open.push(rows.map((r) => r.o));
    out.high.push(rows.map((r) => r.h));
    out.low.push(rows.map((r) => r.l));
    out.close.push(rows.map((r) => r.c));
  }
  return out;
}

/** The funding window the panel checks: the grid's first open to its last bar's close. */
function fundingWindowOf(grid: Span): Span {
  return { from: grid.from, to: grid.to + BAR_MS };
}

/** A funding settlement as the flags see it: its time and its stated interval, never its rate. */
export interface SettlementTime {
  t: number;
  intervalHours: number | null;
}

/**
 * Every funding flag of the panel, as assemblePanel computes them (RV_SYMBOLS order, the same window). The
 * `resolve` stage drafts resolutions for exactly these. The flags depend only on settlement times and stated
 * intervals: each row reaches fundingFlags with a placeholder rate of 0, so nothing here reads a rate. Rates are
 * checked when assemblePanel builds the panel.
 */
export function panelFundingFlags(sources: readonly { symbol: string; funding: readonly SettlementTime[] }[], span: Span): FundingFlag[] {
  const bySymbol = new Map(sources.map((s) => [s.symbol, s]));
  const window = fundingWindowOf(panelGrid(span));
  return RV_SYMBOLS.flatMap((symbol) => {
    const src = bySymbol.get(symbol);
    if (!src) throw new Error(`HALT: no source for ${symbol}`);
    return fundingFlags(
      symbol,
      src.funding.map((r) => ({ t: r.t, intervalHours: r.intervalHours, rate: 0 })),
      window
    );
  });
}

export interface AssembledPanel {
  panel: RvPanel;
  /** The first 1h bar of every panel bar, from the rows the cross-check verified. */
  firstHour: FirstHourBars;
  grid: Span;
  droppedBuckets: DroppedBucket[];
  /** Bar opens some symbols had and others lacked. Always empty, since any dropped bucket halts. */
  droppedTimestamps: number[];
  resolutions: ResolutionsRecord;
}

/**
 * Builds the panel from loaded rows and applies every HALT of the header and its amendments: a null or
 * invalid kline value, any dropped bucket, an unresolved funding flag or an unusable resolutions file,
 * a bar left with no carry input, and any 1h cross-check mismatch. The sources must be exactly the header
 * universe, and the panel follows RV_SYMBOLS order.
 */
export function assemblePanel(sources: readonly RvSymbolSource[], span: Span, resolutions: VerifiedResolutions): AssembledPanel {
  assertVerified(resolutions);
  const bySymbol = new Map(sources.map((s) => [s.symbol, s]));
  if (bySymbol.size !== sources.length || sources.length !== RV_SYMBOLS.length || !RV_SYMBOLS.every((s) => bySymbol.has(s))) {
    throw new Error(`The sources must be exactly the header universe ${RV_SYMBOLS.join(', ')}, got ${sources.map((s) => s.symbol).join(', ')}`);
  }
  const grid = panelGrid(span);
  const fundingWindow = fundingWindowOf(grid);

  const nullTbv: string[] = [];
  for (const symbol of RV_SYMBOLS) {
    for (const r of bySymbol.get(symbol)!.rows4h) {
      if (r.t >= grid.from && r.t < grid.to + BAR_MS && r.tbv === null) nullTbv.push(`${symbol} ${iso(r.t)}`);
    }
  }
  if (nullTbv.length > 0) {
    throw new Error(`HALT: null taker-buy volume on ${nullTbv.length} 4h row(s): ${nullTbv.slice(0, 10).join(', ')}`);
  }

  const droppedBuckets: DroppedBucket[] = [];
  const paired = new Map<string, Bar8h[]>();
  const flags: FundingFlag[] = [];
  for (const symbol of RV_SYMBOLS) {
    const src = bySymbol.get(symbol)!;
    const { bars, dropped } = pairTo8h(src.rows4h, grid);
    for (const t of dropped) droppedBuckets.push({ symbol, t });
    paired.set(symbol, bars);
    flags.push(...fundingFlags(symbol, src.funding, fundingWindow));
  }
  if (droppedBuckets.length > MAX_DROPPED_BUCKETS) {
    throw new Error(
      `HALT: ${droppedBuckets.length} bucket(s) dropped across the panel (AMENDMENT 2 halts on any): ${droppedBuckets
        .map((d) => `${d.symbol} ${iso(d.t)}`)
        .join(', ')}`
    );
  }
  const record = resolveFlags(flags, resolutions, Object.fromEntries(sources.map((s) => [s.symbol, s.funding])));

  const series: SymbolSeries[] = RV_SYMBOLS.map((symbol) => {
    const bars = paired.get(symbol)!;
    const { fundSum, fundLast } = fundingPerBar(bars, bySymbol.get(symbol)!.funding);
    return { symbol, bars, fundSum, fundLast };
  });
  const { panel, droppedTimestamps } = alignPanel(series);
  const rows1h = Object.fromEntries(sources.map((s) => [s.symbol, s.rows1h]));
  const mismatches = crossCheck1h(panel, rows1h);
  if (mismatches.length > 0) {
    const listed = mismatches.slice(0, 10).map((m) => `${m.symbol} ${iso(m.t)} ${m.field} (4h ${m.from4h}, 1h ${m.from1h})`);
    throw new Error(`HALT: the 1h cross-check found ${mismatches.length} mismatch(es): ${listed.join('; ')}`);
  }
  // AMENDMENT 3: a bar with no settlement in its carry window can only follow a cleared flag, and halts
  const fundLastNull: string[] = [];
  panel.symbols.forEach((symbol, si) => panel.fundLast[si].forEach((v, k) => v === null && fundLastNull.push(`${symbol} ${iso(panel.t[k])}`)));
  if (fundLastNull.length > 0) {
    throw new Error(`HALT: ${fundLastNull.length} bar(s) have no carry input (no settlement in (close - 8h, close]): ${fundLastNull.slice(0, 20).join(', ')}`);
  }
  return { panel, firstHour: firstHourBars(panel, rows1h), grid, droppedBuckets, droppedTimestamps, resolutions: record };
}

export interface RvPanelMeta {
  droppedBuckets: DroppedBucket[];
  droppedTimestamps: number[];
  grid: Span;
  manifestHash: string;
  /** sha256 of the canonical JSON (sorted keys) of the panel. */
  panelSha256: string;
  resolutions: ResolutionsRecord;
}

export function panelSha256(panel: RvPanel): string {
  return createHash('sha256').update(stableStringify(panel)).digest('hex');
}

/** The files the panel reads, as the export writes them (export-dataset.ts): path, kind, symbol, interval. */
function panelFiles(symbol: string): { path: string; kind: DatasetKind; interval: string }[] {
  return [
    { path: `perp/${symbol}/4h.jsonl.gz`, kind: 'perp', interval: '4h' },
    { path: `perp/${symbol}/1h.jsonl.gz`, kind: 'perp', interval: '1h' },
    { path: `funding/${symbol}/settlements.jsonl.gz`, kind: 'funding', interval: 'settlements' },
  ];
}

type PanelFileSpec = { path: string; kind: DatasetKind; interval: string };

/**
 * Opens an export: the manifest's dataset hash must match its own file list and list the whole universe. The
 * returned reader requires each file to be listed with its kind, symbol and interval, reads it once, hashes those
 * bytes against the manifest and parses the same bytes (AMENDMENT 2).
 */
function openExport(datasetDir: string): { manifestHash: string; files: ManifestFile[]; read: <T>(symbol: string, spec: PanelFileSpec) => T[] } {
  const manifest = loadManifest(datasetDir);
  if (datasetHashOf(manifest.files) !== manifest.datasetHash) {
    throw new Error(`HALT: the manifest's dataset hash ${manifest.datasetHash} does not match its own file list`);
  }
  const absent = RV_SYMBOLS.filter((s) => !manifest.symbols.includes(s));
  if (absent.length > 0) throw new Error(`HALT: the manifest lacks ${absent.join(', ')}`);

  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  const read = <T>(symbol: string, spec: PanelFileSpec): T[] => {
    const entry = listed.get(spec.path);
    if (!entry) throw new Error(`HALT: a file the panel reads is not listed in the manifest: ${spec.path}`);
    if (entry.kind !== spec.kind || entry.symbol !== symbol || entry.interval !== spec.interval) {
      throw new Error(
        `HALT: ${spec.path} is listed as ${entry.kind}/${entry.symbol}/${entry.interval}, expected ${spec.kind}/${symbol}/${spec.interval}`
      );
    }
    const bytes = readFileSync(join(datasetDir, spec.path));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== entry.sha256) throw new Error(`HALT: sha256 mismatch for ${spec.path}: read ${sha256}, manifest ${entry.sha256}`);
    return parseJsonlGz<T>(bytes);
  };
  return { manifestHash: manifest.datasetHash, files: manifest.files, read };
}

/**
 * The 30 files the panel reads, checked against the manifest and read once each (openExport). Every row is kept,
 * which is what the header's allowLockbox true means.
 */
export function readPanelSources(datasetDir: string): { sources: RvSymbolSource[]; manifestHash: string } {
  const { manifestHash, read } = openExport(datasetDir);
  const sources: RvSymbolSource[] = RV_SYMBOLS.map((symbol) => {
    const [f4h, f1h, fFunding] = panelFiles(symbol);
    return {
      symbol,
      rows4h: read<PerpCandleRow>(symbol, f4h),
      rows1h: read<PerpCandleRow>(symbol, f1h),
      funding: read<FundingRow>(symbol, fFunding),
    };
  });
  return { sources, manifestHash };
}

/**
 * The `resolve` stage's read (pre-review Ruling 3): only the ten funding files, checked against the manifest like
 * every panel file, kept as settlement times and stated intervals. The perp files are never opened, and each rate
 * is dropped as its row is parsed. Also returns the manifest's file list (metadata only) for perpGaps.
 */
export function readFundingTimes(datasetDir: string): {
  funding: { symbol: string; funding: SettlementTime[] }[];
  manifestHash: string;
  files: ManifestFile[];
} {
  const { manifestHash, files, read } = openExport(datasetDir);
  const funding = RV_SYMBOLS.map((symbol) => ({
    symbol,
    funding: read<FundingRow>(symbol, panelFiles(symbol)[2]).map((r) => ({ t: r.t, intervalHours: r.intervalHours })),
  }));
  return { funding, manifestHash, files };
}

// ------------------------------------------------------------------------------------------------ completeness

const PERP_STEP_MS = { '1h': HOUR_MS, '4h': H4_MS } as const;
export type PerpInterval = keyof typeof PERP_STEP_MS;

/** Every open of an interval inside a span: from the span start, on the interval's grid, to the last open at or before the span end. */
export function perpExpected(span: Span, interval: PerpInterval): { rows: number; startMs: number; endMs: number } {
  const step = PERP_STEP_MS[interval];
  if (span.from % step !== 0) throw new Error(`The span must start on the ${interval} grid, got ${iso(span.from)}`);
  const endMs = span.from + Math.floor((span.to - span.from) / step) * step;
  return { rows: (endMs - span.from) / step + 1, startMs: span.from, endMs };
}

export interface PerpCoverage {
  rows: number;
  from: string | null;
  to: string | null;
}

/** A perp file whose manifest entry does not cover the export grid. `found` is null when no such file is listed. */
export interface PerpGap {
  symbol: string;
  interval: PerpInterval;
  expected: PerpCoverage;
  found: PerpCoverage | null;
}

/**
 * Final review Recommendation 4: the 1h and 4h perp file of every header symbol, compared with the export grid of
 * the span from the manifest's rowCount, startMs and endMs alone, so `resolve` reads no row. Every file listed as
 * perp/<symbol>/<interval> with another count or bound, and every one not listed so, is returned. Equal count and
 * bounds mean a complete grid unless a duplicate or off-grid row stands in for a missing one, and those halt at
 * `inputs` (AMENDMENTS 1 and 2).
 */
export function perpGaps(files: readonly ManifestFile[], span: Span): PerpGap[] {
  const gaps: PerpGap[] = [];
  for (const symbol of RV_SYMBOLS) {
    for (const interval of ['1h', '4h'] as const) {
      const want = perpExpected(span, interval);
      const expected = { rows: want.rows, from: iso(want.startMs), to: iso(want.endMs) };
      const path = `perp/${symbol}/${interval}.jsonl.gz`;
      const f = files.find((x) => x.path === path && x.kind === 'perp' && x.symbol === symbol && x.interval === interval);
      if (!f) {
        gaps.push({ symbol, interval, expected, found: null });
      } else if (f.rowCount !== want.rows || f.startMs !== want.startMs || f.endMs !== want.endMs) {
        const at = (t: number | null) => (t === null ? null : iso(t));
        gaps.push({ symbol, interval, expected, found: { rows: f.rowCount, from: at(f.startMs), to: at(f.endMs) } });
      }
    }
  }
  return gaps;
}

/** One gap as the HALT lists it. */
export function formatPerpGap(g: PerpGap): string {
  const found = g.found ? `${g.found.rows} rows ${g.found.from} to ${g.found.to}` : `no file listed as perp/${g.symbol}/${g.interval}`;
  return `${g.symbol} ${g.interval}: expected ${g.expected.rows} rows ${g.expected.from} to ${g.expected.to}, found ${found}`;
}

/**
 * Loads the export, builds the panel with every HALT rule and records the manifest hash, the panel sha256
 * and the resolutions used. The resolutions must come from verifyResolutions in this run (AMENDMENT 3),
 * checked before any file is read. The files are read by readPanelSources. Also returns the first 1h bar of
 * every panel bar for the maker track.
 */
export async function buildRvPanel(
  datasetDir: string,
  span: Span,
  resolutions: VerifiedResolutions
): Promise<{ panel: RvPanel; meta: RvPanelMeta; firstHour: FirstHourBars }> {
  assertVerified(resolutions);
  const { sources, manifestHash } = readPanelSources(datasetDir);
  const assembled = assemblePanel(sources, span, resolutions);
  return {
    panel: assembled.panel,
    firstHour: assembled.firstHour,
    meta: {
      droppedBuckets: assembled.droppedBuckets,
      droppedTimestamps: assembled.droppedTimestamps,
      grid: assembled.grid,
      manifestHash,
      panelSha256: panelSha256(assembled.panel),
      resolutions: assembled.resolutions,
    },
  };
}
