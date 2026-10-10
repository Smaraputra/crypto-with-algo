/**
 * Forward test, cells A1 and A2 (RSI oversold long, RSI overbought short) on the never-read window. The binding
 * spec is the header of forward-test.ts; every constant here is imported from it. Nothing is re-tuned.
 *
 *   npx tsx scripts/research/forward-rsi.ts --dataset-dir D --out report.json
 *       [--draws 1000] [--symbols BTCUSDT,...] [--span-check-start 2025-11-01T00:00:00Z]
 *       [--window-end 2026-11-09T23:59:59.999Z]
 *
 * --window-end (optional): a later instant than the frozen window end runs the monthly continuation over the
 * cumulative window [FORWARD_WINDOW.start, window-end] in DESCRIPTIVE mode (pass is null, never a verdict).
 * Absent or equal to the frozen end is the binding read. Earlier or invalid instants are refused.
 *
 * Memory: the arrays are built ONE SYMBOL AT A TIME (the factor matrix is the peak and is released inside
 * buildSymbolArrays) and reduced to the single raw.rsi flag column before the next symbol is read.
 *
 * --span-check-start (optional, BTCUSDT only): builds the same symbol from an EARLIER data start as well and
 * records, inside the forward window, the maximum absolute difference of raw.rsi and the number of differing
 * label outcomes and raw.rsi tail flags between the two spans, as `rsiSpanCheck`. Wilder RSI and ATR forget their
 * start geometrically, so the differences are expected to be floating-point noise (forward-test.ts header).
 */
import { writeFileSync } from 'fs';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import {
  FORWARD_ALPHA,
  FORWARD_CELLS,
  FORWARD_DATA_START,
  FORWARD_NULL,
  FORWARD_WINDOW,
} from './forward-test';
import { loadManifest, verifyManifest } from './load-dataset';
import { SNIPE_NULL_SD_INFLATION, SNIPE_TIMEFRAMES } from './snipe';
import { gitCommitFromEnv, parseDraws, parseFlags, parseWindowEnd, type ForwardMode } from './snipe-cli';
import { buildSymbolArrays, type SnipeSymbolArrays } from './snipe-matrix';
import {
  buildSliceContext,
  cellBit,
  consistency,
  evaluateCell,
  nullOffsets,
  takenTrades,
  type CellReport,
  type ConsistencyResult,
  type SliceContext,
  type SnipeCell,
} from './snipe-stats';

const FIVE_MIN_MS = 300_000;
/** Span-equality tolerance on raw.rsi (forward-test.ts header, brief section 4). */
export const SPAN_TOLERANCE = 1e-9;
export const SPAN_CHECK_SYMBOL = 'BTCUSDT';

export type ForwardRsiCellName = 'A1' | 'A2';

export interface ForwardRsiArgs {
  datasetDir: string;
  out: string;
  draws: number;
  symbols: string[];
  /** Epoch ms of an earlier data start for the span-equality check, undefined when not requested. */
  spanCheckStart?: number;
  /** ISO end of the measured window: FORWARD_WINDOW.end (binding) or a later instant (descriptive). */
  windowEnd: string;
  mode: ForwardMode;
}

const FLAGS = ['dataset-dir', 'out', 'draws', 'symbols', 'span-check-start', 'window-end'];

export function parseForwardRsiArgs(argv: string[]): ForwardRsiArgs {
  const flags = parseFlags(argv, FLAGS);
  const datasetDir = flags.get('dataset-dir');
  const out = flags.get('out');
  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');
  const symbols = flags.get('symbols') ? flags.get('symbols')!.split(',').map((s) => s.trim()) : [...SIGNAL_SYMBOLS];
  if (symbols.length === 0 || symbols.some((s) => s === '')) throw new Error('--symbols is empty');
  let spanCheckStart: number | undefined;
  const raw = flags.get('span-check-start');
  if (raw !== undefined) {
    spanCheckStart = Date.parse(raw);
    if (Number.isNaN(spanCheckStart)) throw new Error(`--span-check-start is not a date: ${raw}`);
    if (spanCheckStart >= Date.parse(FORWARD_DATA_START)) {
      throw new Error(`--span-check-start must be earlier than the forward data start ${FORWARD_DATA_START}`);
    }
  }
  const { windowEnd, mode } = parseWindowEnd(flags.get('window-end'), FORWARD_WINDOW.end);
  return {
    datasetDir,
    out,
    windowEnd,
    mode,
    draws: parseDraws(flags.get('draws'), FORWARD_NULL.draws),
    symbols,
    ...(spanCheckStart !== undefined ? { spanCheckStart } : {}),
  };
}

export function forwardWindowMs(windowEnd: string = FORWARD_WINDOW.end): { startMs: number; endMs: number } {
  return { startMs: Date.parse(FORWARD_WINDOW.start), endMs: Date.parse(windowEnd) };
}

/** 30 days in 5m bars. */
export function forwardMinShiftBars(): number {
  return Math.round((FORWARD_NULL.minShiftDays * 86_400_000) / FIVE_MIN_MS);
}

/** The frozen cell of A1 or A2 as a SnipeCell. */
export function forwardCell(name: ForwardRsiCellName): SnipeCell {
  const c = FORWARD_CELLS[name];
  return { column: c.column, tail: c.tail, level: c.level, timeframe: c.timeframe };
}

/**
 * Keeps only one column of the arrays (flags, name, finite share), so ten symbols' worth of arrays stay small.
 * Throws when the column is absent.
 */
export function reduceToColumn(arrays: SnipeSymbolArrays, column: string): SnipeSymbolArrays {
  const idx = arrays.columns.indexOf(column);
  if (idx === -1) throw new Error(`forward-rsi: column ${column} is not in the arrays of ${arrays.symbol}`);
  return { ...arrays, columns: [column], flags: [arrays.flags[idx]], finiteShare: [arrays.finiteShare[idx]] };
}

export interface ForwardCellResult {
  name: ForwardRsiCellName;
  cell: SnipeCell;
  direction: 1 | -1;
  /** evaluateCell's report with the frozen direction (its `consistency` field is the quarter form, informational). */
  report: CellReport;
  /** The forward consistency: calendar months (>= 20 resolved trades, >= 3 months, share >= 0.6) and symbols. */
  monthConsistency: ConsistencyResult;
  alpha: number;
  /** The binding verdict, or null in descriptive mode (never a new pass/fail). */
  pass: boolean | null;
  /** Present (true) only in descriptive mode. */
  descriptiveOnly?: true;
}

/**
 * The pre-registered pass rule: empirical one-sided p < alpha AND inflated-z one-sided p < alpha AND the month
 * consistency (months and symbols legs). A NaN p never passes.
 */
export function forwardRsiPass(
  report: Pick<CellReport, 'empiricalP' | 'zP1'>,
  monthConsistency: Pick<ConsistencyResult, 'pass'>,
  alpha: number = FORWARD_ALPHA
): boolean {
  return report.empiricalP < alpha && report.zP1 < alpha && monthConsistency.pass;
}

export function evaluateForwardCell(
  ctx: SliceContext,
  name: ForwardRsiCellName,
  offsets: ArrayLike<number>,
  mode: ForwardMode = 'binding'
): ForwardCellResult {
  const cell = forwardCell(name);
  const direction = FORWARD_CELLS[name].direction as 1 | -1;
  const report = evaluateCell(ctx, cell, offsets, direction);
  const trades = takenTrades(ctx.views, cell.column, cellBit(cell));
  const monthConsistency = consistency(ctx.views, trades, direction, 'month');
  return {
    name,
    cell,
    direction,
    report,
    monthConsistency,
    alpha: FORWARD_ALPHA,
    ...(mode === 'binding'
      ? { pass: forwardRsiPass(report, monthConsistency) }
      : { pass: null, descriptiveOnly: true as const }),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Span-equality check
// ---------------------------------------------------------------------------------------------------------

export interface SpanComparison {
  barsCompared: number;
  barsOnlyInA: number;
  barsOnlyInB: number;
  /** Max |a - b| over bars where both values are finite. */
  maxAbsDiff: number;
  /** Bars where exactly one of the two values is finite. */
  finitenessMismatches: number;
  outcomeMismatches: number;
  flagMismatches: number;
}

export interface SpanSeries {
  timestamps: ArrayLike<number>;
  values: ArrayLike<number>;
  outcome: ArrayLike<number>;
  flags: ArrayLike<number>;
}

/** Compares two builds of the same series on the bars whose timestamp is inside [startMs, endMs], by timestamp. */
export function compareSpans(a: SpanSeries, b: SpanSeries, startMs: number, endMs: number): SpanComparison {
  const byT = new Map<number, number>();
  for (let j = 0; j < b.timestamps.length; j++) {
    const t = b.timestamps[j];
    if (t >= startMs && t <= endMs) byT.set(t, j);
  }
  const out: SpanComparison = {
    barsCompared: 0,
    barsOnlyInA: 0,
    barsOnlyInB: 0,
    maxAbsDiff: 0,
    finitenessMismatches: 0,
    outcomeMismatches: 0,
    flagMismatches: 0,
  };
  let seen = 0;
  for (let i = 0; i < a.timestamps.length; i++) {
    const t = a.timestamps[i];
    if (t < startMs || t > endMs) continue;
    const j = byT.get(t);
    if (j === undefined) {
      out.barsOnlyInA++;
      continue;
    }
    seen++;
    out.barsCompared++;
    const x = a.values[i];
    const y = b.values[j];
    const fx = Number.isFinite(x);
    const fy = Number.isFinite(y);
    if (fx && fy) out.maxAbsDiff = Math.max(out.maxAbsDiff, Math.abs(x - y));
    else if (fx !== fy) out.finitenessMismatches++;
    if (a.outcome[i] !== b.outcome[j]) out.outcomeMismatches++;
    if (a.flags[i] !== b.flags[j]) out.flagMismatches++;
  }
  out.barsOnlyInB = byT.size - seen;
  return out;
}

export interface RsiSpanCheck {
  requested: boolean;
  symbol?: string;
  /** ISO data start of the main span and of the earlier span. */
  mainStart?: string;
  earlierStart?: string;
  window?: { start: string; end: string };
  comparison?: SpanComparison;
  tolerance?: number;
  /** maxAbsDiff within tolerance, no finiteness, outcome or flag mismatches, no bars missing on either side. */
  pass?: boolean;
}

export function spanCheckPass(c: SpanComparison, tolerance: number = SPAN_TOLERANCE): boolean {
  return (
    c.barsCompared > 0 &&
    c.maxAbsDiff <= tolerance &&
    c.finitenessMismatches === 0 &&
    c.outcomeMismatches === 0 &&
    c.flagMismatches === 0 &&
    c.barsOnlyInA === 0 &&
    c.barsOnlyInB === 0
  );
}

function seriesOf(arrays: SnipeSymbolArrays, column: string): SpanSeries {
  if (!arrays.captured || arrays.captured.column !== column) {
    throw new Error(`forward-rsi: arrays of ${arrays.symbol} carry no captured ${column}`);
  }
  const idx = arrays.columns.indexOf(column);
  return { timestamps: arrays.timestamps, values: arrays.captured.values, outcome: arrays.outcome, flags: arrays.flags[idx] };
}

/** Builds the symbol from an earlier start and compares it with `main` inside the window. */
export function runSpanCheck(
  datasetDir: string,
  main: SnipeSymbolArrays,
  earlierStartMs: number,
  window: { startMs: number; endMs: number }
): RsiSpanCheck {
  const column = FORWARD_CELLS.A1.column;
  const earlier = buildSymbolArrays(datasetDir, main.symbol, 'scalp', {
    allowLockbox: true,
    startMs: earlierStartMs,
    endMs: window.endMs,
    captureColumn: column,
  });
  const comparison = compareSpans(seriesOf(main, column), seriesOf(earlier, column), window.startMs, window.endMs);
  return {
    requested: true,
    symbol: main.symbol,
    mainStart: FORWARD_DATA_START,
    earlierStart: new Date(earlierStartMs).toISOString(),
    window: { start: new Date(window.startMs).toISOString(), end: new Date(window.endMs).toISOString() },
    comparison,
    tolerance: SPAN_TOLERANCE,
    pass: spanCheckPass(comparison),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------

export interface ForwardRsiReport {
  reportKind: 'forward-rsi';
  schemaVersion: 1;
  mode: ForwardMode;
  binding: boolean;
  datasetManifestHash: string;
  gitCommit: string;
  computedAt: string;
  window: { start: string; end: string };
  dataStart: string;
  draws: number;
  seed: number;
  minShiftDays: number;
  sdInflation: number;
  alpha: number;
  symbols: string[];
  gridBars: number;
  cells: ForwardCellResult[];
  rsiSpanCheck: RsiSpanCheck;
}

export async function runForwardRsi(
  args: ForwardRsiArgs,
  log: (line: string) => void = console.log
): Promise<ForwardRsiReport> {
  if (SNIPE_NULL_SD_INFLATION !== FORWARD_NULL.sdInflation) {
    throw new Error(
      `forward-rsi: SNIPE_NULL_SD_INFLATION ${SNIPE_NULL_SD_INFLATION} differs from FORWARD_NULL.sdInflation ${FORWARD_NULL.sdInflation}`
    );
  }
  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) throw new Error(`forward-rsi: dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  const manifestHash = loadManifest(args.datasetDir).datasetHash;

  const window = forwardWindowMs(args.windowEnd);
  const wantSpan = args.spanCheckStart !== undefined;
  const column = FORWARD_CELLS.A1.column;
  const reduced: SnipeSymbolArrays[] = [];
  let spanMain: SnipeSymbolArrays | undefined;
  for (const symbol of args.symbols) {
    const full = buildSymbolArrays(args.datasetDir, symbol, 'scalp', {
      allowLockbox: true,
      startMs: Date.parse(FORWARD_DATA_START),
      endMs: window.endMs,
      ...(wantSpan && symbol === SPAN_CHECK_SYMBOL ? { captureColumn: column } : {}),
    });
    const small = reduceToColumn(full, column);
    reduced.push(small);
    if (small.captured) spanMain = small;
    log(`[forward-rsi] ${symbol}: ${small.timestamps.length} bars`);
  }

  const ctx = buildSliceContext(reduced, window, 'scalp', SNIPE_TIMEFRAMES.scalp.maxHoldMs);
  const offsets = nullOffsets(ctx.grid.G, forwardMinShiftBars(), args.draws, FORWARD_NULL.seed);
  const cells = (['A1', 'A2'] as const).map((name) => evaluateForwardCell(ctx, name, offsets, args.mode));

  let rsiSpanCheck: RsiSpanCheck = { requested: false };
  if (wantSpan) {
    if (!spanMain) throw new Error(`forward-rsi: --span-check-start needs ${SPAN_CHECK_SYMBOL} in --symbols`);
    rsiSpanCheck = runSpanCheck(args.datasetDir, spanMain, args.spanCheckStart!, window);
  }

  const report: ForwardRsiReport = {
    reportKind: 'forward-rsi',
    schemaVersion: 1,
    mode: args.mode,
    binding: args.mode === 'binding',
    datasetManifestHash: manifestHash,
    gitCommit: gitCommitFromEnv(),
    computedAt: new Date().toISOString(),
    window: { start: FORWARD_WINDOW.start, end: args.windowEnd },
    dataStart: FORWARD_DATA_START,
    draws: args.draws,
    seed: FORWARD_NULL.seed,
    minShiftDays: FORWARD_NULL.minShiftDays,
    sdInflation: FORWARD_NULL.sdInflation,
    alpha: FORWARD_ALPHA,
    symbols: args.symbols,
    gridBars: ctx.grid.G,
    cells,
    rsiSpanCheck,
  };
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  log(`forward-rsi ${args.mode} (window ${FORWARD_WINDOW.start} to ${args.windowEnd}, draws ${args.draws}, alpha ${FORWARD_ALPHA.toFixed(5)})`);
  for (const c of cells) {
    const r = c.report;
    log(
      `  ${c.name} dir ${c.direction} ${c.pass === null ? 'DESCRIPTIVE' : c.pass ? 'PASS' : 'FAIL'} resolved ${r.resolved} win ${r.winRate.toFixed(4)} ` +
        `base ${r.baseline.toFixed(4)} excess ${r.obsAll.toFixed(4)} p ${r.empiricalP.toFixed(4)} zP1 ${r.zP1.toExponential(2)} ` +
        `months ${c.monthConsistency.quarters.agree}/${c.monthConsistency.quarters.kept} ` +
        `symbols ${c.monthConsistency.symbols.agree}/${c.monthConsistency.symbols.kept} ` +
        `BE maker ${r.makerBreakEven.toFixed(4)} taker ${r.takerBreakEven.toFixed(4)}`
    );
  }
  if (rsiSpanCheck.requested) {
    const k = rsiSpanCheck.comparison!;
    log(
      `  rsiSpanCheck ${rsiSpanCheck.pass ? 'PASS' : 'FAIL'} ${rsiSpanCheck.symbol}: max |d rsi| ${k.maxAbsDiff.toExponential(2)}, ` +
        `outcome mismatches ${k.outcomeMismatches}, flag mismatches ${k.flagMismatches}, bars ${k.barsCompared}`
    );
  }
  return report;
}

if (require.main === module) {
  runForwardRsi(parseForwardRsiArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
