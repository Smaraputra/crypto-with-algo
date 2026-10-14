/**
 * The 8h perp panel for the rv-v1 re-validation (header DATA in scripts/research/rv-revalidation.ts).
 *
 * 4h perp klines are paired into 8h bars at 00, 08 and 16 UTC, each bar carries the funding settled in
 * (bar open, bar close], the ten symbols are intersected onto one rectangular grid, and the 8h bars are
 * rebuilt from the 1h klines as a cross-check. Every HALT rule of the header throws here, so a panel
 * that comes back is one the study may use.
 *
 * Panel end: the last bar is the last one whose funding window (open, open + 8h] closes inside the export
 * span. The export stops at 2026-10-13T23:59:59.999Z, so the settlement at 2026-10-14 00:00 is not in it
 * and the 16:00 bar of the final day has an incomplete funding sum. That bar is left out of the grid
 * rather than carried with a partial sum, which a permutation would otherwise move into the middle of
 * the panel.
 */
import { createHash } from 'crypto';

import type { OHLCV } from '@/types/market';
import { RV_V1 } from '@/lib/signals/cross-sectional/engine';
import { missingSettlements } from './broad-inputs';
import { stableStringify } from './broad-trend';
import type { FundingRow, PerpCandleRow } from './dataset-format';
import { loadFunding, loadManifest, loadPerp, verifyManifest } from './load-dataset';
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

/** Header: HALT if more than 3 buckets are dropped across the panel. */
export const MAX_DROPPED_BUCKETS = 3;

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

const iso = (t: number) => new Date(t).toISOString();

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
 * half (or both) is dropped and listed. Rows outside the grid are ignored.
 */
export function pairTo8h(rows4h: readonly PerpCandleRow[], grid: Span): { bars: Bar8h[]; dropped: number[] } {
  if (grid.from % BAR_MS !== 0 || grid.to % BAR_MS !== 0 || grid.to < grid.from) {
    throw new Error(`The pairing grid must run between 8h boundaries, got ${iso(grid.from)} to ${iso(grid.to)}`);
  }
  const byOpen = new Map<number, PerpCandleRow>();
  for (const row of rows4h) {
    if (row.t % H4_MS !== 0) throw new Error(`A 4h row at ${iso(row.t)} is off the 4h grid`);
    if (byOpen.has(row.t)) throw new Error(`Duplicate 4h row at ${iso(row.t)}`);
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
 * Fills a null intervalHours (rows written by the REST sync) from the spacing of consecutive settlements.
 * Each gap is accepted as the interval in force when it is a Binance interval (1, 2, 4 or 8 hours) and
 * equals the gap before or after it, so an interval switch in either direction is clean. Otherwise the gap
 * is judged at the smallest neighbouring gap that is a Binance interval, so a lone long gap (a missing
 * settlement) is flagged by missingSettlements. A row takes the interval of the gap that ends at it, and
 * the first row takes the first gap's. Known blind spot: settlements missing in a strictly alternating
 * pattern (4h gaps 4, 8, 8, 4) pass as a switch.
 */
export function deriveIntervals(symbol: string, sorted: readonly FundingRow[]): FundingRow[] {
  if (sorted.every((r) => r.intervalHours !== null)) return [...sorted];
  if (sorted.length < 2) {
    throw new Error(`HALT: ${symbol} has a settlement without intervalHours and no spacing to derive the interval from`);
  }
  const gaps: number[] = [];
  for (let k = 0; k + 1 < sorted.length; k++) gaps.push((sorted[k + 1].t - sorted[k].t) / HOUR_MS);
  const derived = (k: number): number => {
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
  return sorted.map((row, i) => (row.intervalHours !== null ? row : { ...row, intervalHours: derived(Math.max(0, i - 1)) }));
}

/**
 * HALT on any settlement due in (window.from, window.to] that the rows lack. A gap is judged by its later
 * row's interval (missingSettlements, shared with the broad study), a null interval is derived from the
 * spacing first (deriveIntervals), and the grid extends from the first row back to window.from and from
 * the last row forward to window.to. Rows outside the window only serve as spacing neighbours.
 */
export function checkFunding(symbol: string, rows: readonly FundingRow[], window: Span): void {
  if (rows.length === 0) throw new Error(`HALT: ${symbol} has no settlement at all`);
  for (const r of rows) {
    if (r.t % HOUR_MS !== 0) throw new Error(`HALT: ${symbol} settlement at ${iso(r.t)} is not on an hour boundary`);
  }
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].t === sorted[i - 1].t) throw new Error(`HALT: ${symbol} has a duplicate settlement at ${iso(sorted[i].t)}`);
  }
  const withIntervals = deriveIntervals(symbol, sorted);
  const inWindow = withIntervals.filter((r) => r.t > window.from && r.t <= window.to);

  // missingSettlements works in days: settlements in (d, d + 1 day] are due on day d. Every day touched by
  // the window is checked, the backward extension stops at firstDay + 1 day = window.from, and its
  // lockbox bound ends the forward extension at window.to (lifeEnd = min(lastDay + 1 day, lockbox - 1)).
  const firstDayChecked = Math.floor(window.from / DAY_MS) * DAY_MS;
  const lastDayChecked = Math.floor((window.to - 1) / DAY_MS) * DAY_MS;
  const checkDays = new Set<number>();
  for (let d = firstDayChecked; d <= lastDayChecked; d += DAY_MS) checkDays.add(d);
  const contract = {
    id: symbol,
    firstDay: window.from - DAY_MS,
    lastDay: Math.floor(window.to / DAY_MS) * DAY_MS,
    endDay: null,
  };
  const missing = missingSettlements(contract, inWindow, checkDays, window.to + 1);
  if (missing.length > 0) {
    const listed = missing.slice(0, 10).map((m) => `${iso(m.t)} (${m.reason})`);
    throw new Error(
      `HALT: ${missing.length} missing due funding settlement(s) for ${symbol}: ${listed.join(', ')}${missing.length > 10 ? ', ...' : ''}`
    );
  }
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
 * ('missing'), as is a null 1h taker-buy volume ('tbv').
 */
export function crossCheck1h(panel: RvPanel, rows1h: Readonly<Record<string, readonly PerpCandleRow[]>>): PanelMismatch[] {
  const out: PanelMismatch[] = [];
  panel.symbols.forEach((symbol, si) => {
    const byOpen = new Map<number, PerpCandleRow>();
    for (const r of rows1h[symbol] ?? []) byOpen.set(r.t, r);
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

export interface AssembledPanel {
  panel: RvPanel;
  grid: Span;
  droppedBuckets: DroppedBucket[];
  /** Bar opens some symbols had and others lacked, removed by the intersection. */
  droppedTimestamps: number[];
}

/**
 * Builds the panel from loaded rows and applies every header HALT: null taker-buy volume, more than
 * MAX_DROPPED_BUCKETS dropped buckets across the panel, a missing due settlement, and any 1h cross-check
 * mismatch. The sources must be exactly the header universe, and the panel follows RV_SYMBOLS order.
 */
export function assemblePanel(sources: readonly RvSymbolSource[], span: Span): AssembledPanel {
  const bySymbol = new Map(sources.map((s) => [s.symbol, s]));
  if (bySymbol.size !== sources.length || sources.length !== RV_SYMBOLS.length || !RV_SYMBOLS.every((s) => bySymbol.has(s))) {
    throw new Error(`The sources must be exactly the header universe ${RV_SYMBOLS.join(', ')}, got ${sources.map((s) => s.symbol).join(', ')}`);
  }
  const grid = panelGrid(span);
  const fundingWindow = { from: grid.from, to: grid.to + BAR_MS };

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
  const series: SymbolSeries[] = [];
  for (const symbol of RV_SYMBOLS) {
    const src = bySymbol.get(symbol)!;
    const { bars, dropped } = pairTo8h(src.rows4h, grid);
    for (const t of dropped) droppedBuckets.push({ symbol, t });
    checkFunding(symbol, src.funding, fundingWindow);
    const { fundSum, fundLast } = fundingPerBar(bars, src.funding);
    series.push({ symbol, bars, fundSum, fundLast });
  }
  if (droppedBuckets.length > MAX_DROPPED_BUCKETS) {
    throw new Error(
      `HALT: ${droppedBuckets.length} buckets dropped across the panel, more than ${MAX_DROPPED_BUCKETS}: ${droppedBuckets
        .map((d) => `${d.symbol} ${iso(d.t)}`)
        .join(', ')}`
    );
  }

  const { panel, droppedTimestamps } = alignPanel(series);
  const mismatches = crossCheck1h(panel, Object.fromEntries(sources.map((s) => [s.symbol, s.rows1h])));
  if (mismatches.length > 0) {
    const listed = mismatches.slice(0, 10).map((m) => `${m.symbol} ${iso(m.t)} ${m.field} (4h ${m.from4h}, 1h ${m.from1h})`);
    throw new Error(`HALT: the 1h cross-check found ${mismatches.length} mismatch(es): ${listed.join('; ')}`);
  }
  return { panel, grid, droppedBuckets, droppedTimestamps };
}

export interface RvPanelMeta {
  droppedBuckets: DroppedBucket[];
  droppedTimestamps: number[];
  grid: Span;
  manifestHash: string;
  /** sha256 of the canonical JSON (sorted keys) of the panel. */
  panelSha256: string;
}

export function panelSha256(panel: RvPanel): string {
  return createHash('sha256').update(stableStringify(panel)).digest('hex');
}

/**
 * Loads the export (allowLockbox true, as the header declares), verifies every file against the manifest,
 * builds the panel with all HALT rules and records the manifest hash and the panel sha256.
 */
export async function buildRvPanel(datasetDir: string, span: Span): Promise<{ panel: RvPanel; meta: RvPanelMeta }> {
  const verified = await verifyManifest(datasetDir);
  if (!verified.ok) {
    throw new Error(`HALT: the dataset no longer matches its manifest: ${verified.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(datasetDir);
  const absent = RV_SYMBOLS.filter((s) => !manifest.symbols.includes(s));
  if (absent.length > 0) throw new Error(`HALT: the manifest lacks ${absent.join(', ')}`);

  const opts = { allowLockbox: true };
  const sources: RvSymbolSource[] = RV_SYMBOLS.map((symbol) => ({
    symbol,
    rows4h: loadPerp(datasetDir, symbol, '4h', 'klines', opts).rows,
    rows1h: loadPerp(datasetDir, symbol, '1h', 'klines', opts).rows,
    funding: loadFunding(datasetDir, symbol, opts).rows,
  }));
  const { panel, grid, droppedBuckets, droppedTimestamps } = assemblePanel(sources, span);
  return {
    panel,
    meta: { droppedBuckets, droppedTimestamps, grid, manifestHash: manifest.datasetHash, panelSha256: panelSha256(panel) },
  };
}
