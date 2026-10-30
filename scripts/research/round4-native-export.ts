/**
 * Round 4 Phase 4 calibration: native replay exports of the closed rules (brief 29a, calibration-spec-v1 section 6).
 *
 * Signed lock M, PIPELINE CALIBRATION: the closed rules are re-tested as labelled re-reads and negative controls.
 * Their decisions come from each rule's FROZEN code, imported here and never edited or re-described:
 *
 *   rv-v1   rv-panel.ts buildRvPanel and rv-synthetic.ts rvV1TakerSteps (the engine's rvStep)
 *   s1, s2  lab-v4-preview.ts c1Signals / c2Signals and tradesFor, called per symbol so the symbol is kept
 *   c1      nv1-c1-scores.ts c1Scores, nv1-c1.ts coinSeriesInWindow, nv1-core.ts buildTrades at k = 1
 *   v8-1h,
 *   v8-4h   strategy-harness.ts runStrategyHarness, family dx-d0 (direction-exit D0) at E1, report trades by
 *           direction-exit-judge.ts tradesOf
 *
 * Usage (one rule per call, run on the VPS, never on the Mac):
 *   round4-native-export.ts <rule> --dataset-dir DIR --out DIR [--resolutions FILE]   (--resolutions: rv-v1 only)
 *
 * Decisions and evaluation are restricted to [2022-01-01, 2026-07-01). Two rules read older spot bars as warm-up
 * only, before the span starts: v8 reads spot from 2021-10-01 (V8_HARNESS_START) and c1 reads spot 1h from
 * 2021-10-14 (the end of holdout A). Each summary records this in warmup_from. Holdout H is not read: the loader
 * clips perp 5m to 4h before 2022 (the holdout A clip), so no perp intraday bar before 2022-01-01 reaches this
 * script, and spot intraday before the span is outside the allowance N7 states for the span itself. Neither
 * --allow-lockbox nor any holdout flag exists, and the parser refuses them. No callee below is passed allowLockbox
 * or allowHoldoutA (grep: loadPerp, loadFunding, loadCandles are called with their default options, which apply the
 * lockbox and holdout A clips).
 *
 * Output per rule: tranches.jsonl (TRANCHE_FIELDS) and summary.json. The summary's parity block reports the export's
 * trade count and mean net per trade next to the recorded RESULT values and their difference. It never fails on a
 * mismatch: the lead judges parity.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RV_V1 } from '../../src/lib/signals/cross-sectional/engine';
import { SIGNAL_SYMBOLS } from '../../src/lib/signals/signal-symbols';
import type { OHLCV } from '../../src/types/market';
import { DIRECTION_EXIT_SYMBOLS } from './direction-exit';
import { tradesOf } from './direction-exit-judge';
import { loadCandles, loadFunding, loadManifest, loadPerp, verifyManifest } from './load-dataset';
import { ROUND_TRIP_COST, c1Signals, c2Signals, tradesFor } from './lab-v4-preview';
import { NV1_LOCK } from './next-version-v1';
import { NV1_C1, coinSeriesInWindow } from './nv1-c1';
import { NV1_SYMBOLS, c1Scores, type ScoreRow } from './nv1-c1-scores';
import { buildTrades } from './nv1-core';
import { buildRvPanel, type RvPanel, type Span } from './rv-panel';
import { ANNUALISATION, rvV1TakerSteps, type RvV1TakerStep } from './rv-synthetic';
import type { StrategyReport } from './report-schema';
import { parseArgs as parseHarnessArgs, runStrategyHarness, type StrategyHarnessArgs } from './strategy-harness';

export const RULES = ['rv-v1', 's1', 's2', 'c1', 'v8-1h', 'v8-4h'] as const;
export type Rule = (typeof RULES)[number];

/** Every read is inside [from, to): development D with the lockbox excluded. */
export const EXPORT_SPAN = { from: Date.UTC(2022, 0, 1), to: Date.UTC(2026, 6, 1) } as const;

/** One tranche weighs 1/10 of equity (the 10-slot daily book), signed by side. */
export const SLOT_WEIGHT = 1 / 10;

export const TRANCHE_FIELDS = [
  'rule', 'symbol', 'side', 'entry_ms', 'exit_ms', 'entry_price', 'exit_price', 'weight', 'exit_reason', 'price_source',
] as const;

export interface Tranche {
  rule: Rule;
  symbol: string;
  side: 1 | -1;
  entry_ms: number;
  exit_ms: number;
  entry_price: number;
  /** Null only where the frozen report does not carry the fill (v8 non-horizon exits). */
  exit_price: number | null;
  /** Signed fraction of equity. */
  weight: number;
  exit_reason: string;
  price_source: 'perp' | 'spot';
}

export interface ExportSummary {
  rule: Rule;
  n_tranches: number;
  /** Mean net return per native unit (per trade, per 8h step for rv-v1), as a fraction. */
  mean_net_native: number | null;
  manifest_hash: string;
  /** Start of the history the rule's own code reads before its first decision, ISO. */
  warmup_from: string;
  span: { from: string; to_exclusive: string };
  costs: { fee_taker: number; fee_maker: number | null; slippage_bps: number; round_trip: number };
  parity: Record<string, unknown>;
  [extra: string]: unknown;
}

/** Recorded RESULT values the parity block compares with. Fractions, not percent. */
export const NATIVE_REFERENCE = {
  's1': { trades: 2459, mean_net: -0.00126, note: 'lab-v4-preview.ts RESULT, 2022-01-01 to 2026-06-30' },
  's2': { trades: 1594, mean_net: -0.00093, note: 'lab-v4-preview.ts RESULT, 2022-01-01 to 2026-06-30' },
  'c1': {
    trades: 2990,
    mean_net: 0.00085,
    note: 'next-version-v1.ts RESULT, k = 1 on holdout A (2017-08-17 to 2021-10-14), a different span: expect a different value',
  },
  'v8-1h': {
    trades: 3614,
    mean_net: -0.00165,
    note: 'direction-exit.ts CONFIRM, 1h D0 E1, 2025-01-01 to 2026-10-09 (the export is cut at 2026-06-30)',
  },
  'v8-4h': {
    trades: 411,
    mean_net: 0.0003,
    note: 'direction-exit.ts CONFIRM, 4h D0 E1, 2025-01-01 to 2026-10-09 (the export is cut at 2026-06-30)',
  },
  'rv-v1': {
    trades: 5197,
    sharpe: 0.8674,
    note: 'rv-revalidation.ts RESULT, net taker Sharpe over 5,197 bars, 2022-01-15 to 2026-10-13 (trades = 8h steps)',
  },
} as const;

const ISO = (ms: number): string => new Date(ms).toISOString();

// ------------------------------------------------------------------------------------------------ CLI

export interface CliOptions {
  rule: Rule;
  datasetDir: string;
  out: string;
  resolutions?: string;
}

const REFUSED = /allow-?lockbox|allow-?holdout|holdout/i;

export function parseCliArgs(argv: string[]): CliOptions {
  const [rule, ...rest] = argv;
  if (!rule || !(RULES as readonly string[]).includes(rule)) {
    throw new Error(`Unknown rule "${rule ?? ''}", expected one of: ${RULES.join(', ')}`);
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    if (REFUSED.test(arg)) {
      throw new Error(`REFUSE: ${arg}: this export never reads the lockbox (2026-07-01 on) or any holdout`);
    }
    const key = arg.slice(2);
    if (key !== 'dataset-dir' && key !== 'out' && key !== 'resolutions') throw new Error(`Unknown flag ${arg}`);
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    flags.set(key, value);
    i++;
  }
  const datasetDir = flags.get('dataset-dir');
  const out = flags.get('out');
  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');
  return { rule: rule as Rule, datasetDir, out, resolutions: flags.get('resolutions') };
}

export function writeExport(outDir: string, tranches: readonly Tranche[], summary: ExportSummary): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'tranches.jsonl'), tranches.map((t) => JSON.stringify(t)).join('\n') + (tranches.length > 0 ? '\n' : ''), 'utf8');
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
}

// ------------------------------------------------------------------------------------------------ helpers

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, v) => s + v, 0) / xs.length;
}

function inSpan(t: number): boolean {
  return t >= EXPORT_SPAN.from && t < EXPORT_SPAN.to;
}

function sortTranches<T extends { tranche: Tranche }>(items: T[]): T[] {
  return items.sort((a, b) => a.tranche.entry_ms - b.tranche.entry_ms || a.tranche.symbol.localeCompare(b.tranche.symbol));
}

export interface TrancheSet {
  tranches: Tranche[];
  /** The rule's own net return per tranche (its native cost function), same order as tranches. */
  nativeNets: number[];
}

function toSet(items: { tranche: Tranche; net: number }[]): TrancheSet {
  const sorted = sortTranches(items);
  return { tranches: sorted.map((i) => i.tranche), nativeNets: sorted.map((i) => i.net) };
}

// ------------------------------------------------------------------------------------------------ S1 and S2

export interface SymbolBars {
  bars: readonly OHLCV[];
  settlements: readonly { t: number; rate: number }[];
}

/**
 * S1 (c1Signals) or S2 (c2Signals) on each symbol's 1h perp bars restricted to the span, then tradesFor per symbol
 * (the preview flattened the trades and dropped the symbol). Entry at the next 1h open, exit 8 bars later, one trade
 * per coin at a time, native cost 0.0014. Swing structure needs no history before the span in the preview, so there
 * is no warm-up read either.
 */
export function signalTranches(rule: 's1' | 's2', dataBySymbol: Record<string, SymbolBars>): TrancheSet {
  const items: { tranche: Tranche; net: number }[] = [];
  for (const [symbol, data] of Object.entries(dataBySymbol)) {
    const bars = data.bars.filter((b) => inSpan(b.timestamp));
    const settlements = data.settlements.filter((s) => inSpan(s.t));
    const signals = rule === 's1' ? c1Signals(bars) : c2Signals(bars);
    const openAt = new Map(bars.map((b) => [b.timestamp, b.open]));
    for (const trade of tradesFor(bars, settlements, signals)) {
      const entry = openAt.get(trade.entryTime);
      const exit = openAt.get(trade.exitTime);
      if (entry === undefined || exit === undefined) throw new Error(`${symbol}: no bar at a trade fill time`);
      const side = trade.side as 1 | -1;
      items.push({
        net: trade.net,
        tranche: {
          rule, symbol, side, entry_ms: trade.entryTime, exit_ms: trade.exitTime, entry_price: entry, exit_price: exit,
          weight: side * SLOT_WEIGHT, exit_reason: 'horizon', price_source: 'perp',
        },
      });
    }
  }
  return toSet(items);
}

// ------------------------------------------------------------------------------------------------ rv-v1

/** The panel span: the last bar closes before 2026-06-30 23:59:59.999, so no lockbox settlement enters a carry window. */
export function rvSpan(): Span {
  return { from: EXPORT_SPAN.from, to: EXPORT_SPAN.to - 1 };
}

/**
 * Per step k of rvV1TakerSteps, every coin held after the rebalance at bar k + 1's open is one tranche, entered at
 * that open and left at the next rebalance open (bar k + 2). The last step has no next rebalance: it exits at bar
 * k + 1's close, labelled end_of_data. weight = qty x open / equity before the step.
 */
export function rvTranches(panel: RvPanel, steps: readonly RvV1TakerStep[] = rvV1TakerSteps(panel)): Tranche[] {
  const out: Tranche[] = [];
  const n = panel.t.length;
  steps.forEach((step, i) => {
    const equityBefore = i === 0 ? RV_V1.startingEquity : steps[i - 1].equityAfter;
    const k = step.k;
    const hasNext = k + 2 < n;
    panel.symbols.forEach((symbol, s) => {
      const pos = step.after.positions[symbol];
      if (!pos || pos.qty === 0) return;
      const entryPrice = panel.open[s][k + 1];
      out.push({
        rule: 'rv-v1', symbol, side: pos.qty > 0 ? 1 : -1,
        entry_ms: panel.t[k + 1],
        exit_ms: hasNext ? panel.t[k + 2] : panel.t[k + 1] + RV_V1.barMs,
        entry_price: entryPrice,
        exit_price: hasNext ? panel.open[s][k + 2] : panel.close[s][k + 1],
        weight: (pos.qty * entryPrice) / equityBefore,
        exit_reason: hasNext ? 'rebalance' : 'end_of_data',
        price_source: 'perp',
      });
    });
  });
  return out.sort((a, b) => a.entry_ms - b.entry_ms || a.symbol.localeCompare(b.symbol));
}

export function rvStepStats(steps: readonly RvV1TakerStep[]): { n: number; mean: number | null; sharpeAnn: number | null } {
  const r = steps.map((s) => s.ret);
  const m = mean(r);
  if (m === null || r.length < 2) return { n: r.length, mean: m, sharpeAnn: null };
  const sd = Math.sqrt(r.reduce((s, v) => s + (v - m) ** 2, 0) / (r.length - 1));
  return { n: r.length, mean: m, sharpeAnn: sd > 0 ? (m / sd) * ANNUALISATION : null };
}

// ------------------------------------------------------------------------------------------------ C1

/**
 * Round 1 C1 at k = 1 on spot 1h score rows (nv1-c1-scores.ts c1Scores output): coinSeriesInWindow at c90 from the
 * lock, buildTrades with the C1 lock's hold 24, step 1h and flat cost 0.16 percent. A trade opens at the close of
 * bar i, stamped at bar i + 1's open time, and closes at the close of bar i + 24. Prices are spot closes.
 */
export function c1Tranches(rows: readonly ScoreRow[], c90: number = NV1_LOCK.c1.c90): TrancheSet {
  const symbols = [...new Set(rows.map((r) => r.symbol))].sort();
  const items: { tranche: Tranche; net: number }[] = [];
  for (const symbol of symbols) {
    const series = coinSeriesInWindow(rows, symbol, EXPORT_SPAN.from, EXPORT_SPAN.to, c90);
    const closeAt = new Map(series.t.map((t, i) => [t, series.close[i]]));
    const trades = buildTrades(series, {
      k: 1, hold: NV1_C1.hold, stepMs: NV1_C1.stepMs, costPct: NV1_C1.costPct, from: EXPORT_SPAN.from, to: EXPORT_SPAN.to,
    });
    for (const t of trades) {
      const entry = closeAt.get(t.openT);
      const exit = closeAt.get(t.closeT);
      if (entry === undefined || exit === undefined) throw new Error(`${symbol}: no close at a trade time`);
      items.push({
        net: t.netPct / 100,
        tranche: {
          rule: 'c1', symbol, side: t.d, entry_ms: t.openT + NV1_C1.stepMs, exit_ms: t.closeT + NV1_C1.stepMs,
          entry_price: entry, exit_price: exit, weight: t.d * SLOT_WEIGHT, exit_reason: 'horizon', price_source: 'spot',
        },
      });
    }
  }
  return toSet(items);
}

// ------------------------------------------------------------------------------------------------ v8

export const V8_LABEL = 'v8 without news; long/short ratio and open interest absent before 2026-03; NOT the live v8';

/** The harness history start: the runbook's DS_START (scripts/ops/direction-exit-run.sh), three months of warm-up. */
export const V8_HARNESS_START = Date.UTC(2021, 9, 1);

/**
 * The harness arguments of a direction-exit D0 E1 run (scripts/ops/direction-exit-run.sh harness_run), with perp
 * prices, the dev-window shape (benchmark off) and the end moved to 2026-06-30 23:59:59.999. No lockbox flag.
 */
export function v8HarnessArgs(interval: '1h' | '4h', datasetDir: string, out: string): StrategyHarnessArgs {
  return parseHarnessArgs([
    '--family', 'dx-d0', '--interval', interval, '--fixed-eval', '--fix-params', 'exit=1,k=1',
    '--symbols', DIRECTION_EXIT_SYMBOLS.join(','),
    '--start', ISO(V8_HARNESS_START), '--eval-from', ISO(EXPORT_SPAN.from), '--end', ISO(EXPORT_SPAN.to - 1),
    '--no-benchmark', '--funding-settlements', '--windows', '6', '--price', 'perp',
    '--dataset-dir', datasetDir, '--out', out,
  ]);
}

const V8_REASON: Record<string, string> = { time_stop: 'horizon', stop_loss: 'stop' };

/**
 * The report carries entry and exit times, side, pnlPercent (net of the harness's fees, slippage and funding) and the
 * exit reason, but not the fills. Entry price is the perp open at entryTime. A time_stop closes at that bar's close
 * (bar-loop.ts), so its exit price is the close at exitTime. Any other exit has no recoverable fill and stays null.
 */
export function v8Tranches(
  rule: 'v8-1h' | 'v8-4h',
  report: StrategyReport,
  perpBars: Record<string, readonly OHLCV[]>
): TrancheSet {
  const barAt = new Map<string, Map<number, OHLCV>>();
  for (const [symbol, bars] of Object.entries(perpBars)) barAt.set(symbol, new Map(bars.map((b) => [b.timestamp, b])));
  const items: { tranche: Tranche; net: number }[] = [];
  for (const t of tradesOf(report)) {
    const bars = barAt.get(t.symbol);
    const entryBar = bars?.get(t.entryTime);
    if (!entryBar) throw new Error(`${t.symbol}: no perp bar at entry ${ISO(t.entryTime)}`);
    const side = t.side === 'long' ? 1 : -1;
    let exitPrice: number | null = null;
    if (t.exitReason === 'time_stop') {
      const exitBar = bars?.get(t.exitTime);
      if (!exitBar) throw new Error(`${t.symbol}: no perp bar at exit ${ISO(t.exitTime)}`);
      exitPrice = exitBar.close;
    }
    items.push({
      net: t.pnlPercent / 100,
      tranche: {
        rule, symbol: t.symbol, side, entry_ms: t.entryTime, exit_ms: t.exitTime, entry_price: entryBar.open,
        exit_price: exitPrice, weight: side * SLOT_WEIGHT, exit_reason: V8_REASON[t.exitReason] ?? t.exitReason,
        price_source: 'perp',
      },
    });
  }
  return toSet(items);
}

// ------------------------------------------------------------------------------------------------ summaries

function parityOf(rule: Rule, nExport: number, meanExport: number | null): Record<string, unknown> {
  const ref = NATIVE_REFERENCE[rule] as { trades: number; mean_net?: number; note: string };
  return {
    recorded_trades: ref.trades,
    export_trades: nExport,
    trades_diff: nExport - ref.trades,
    recorded_mean_net: ref.mean_net ?? null,
    export_mean_net: meanExport,
    mean_net_diff: ref.mean_net !== undefined && meanExport !== null ? meanExport - ref.mean_net : null,
    reference: ref.note,
  };
}

function baseSummary(rule: Rule, set: TrancheSet, manifestHash: string, warmupFrom: number): ExportSummary {
  const m = mean(set.nativeNets);
  return {
    rule,
    n_tranches: set.tranches.length,
    mean_net_native: m,
    manifest_hash: manifestHash,
    warmup_from: ISO(warmupFrom),
    span: { from: ISO(EXPORT_SPAN.from), to_exclusive: ISO(EXPORT_SPAN.to) },
    costs: { fee_taker: 0.0005, fee_maker: 0.0002, slippage_bps: 2, round_trip: ROUND_TRIP_COST },
    parity: parityOf(rule, set.tranches.length, m),
  };
}

// ------------------------------------------------------------------------------------------------ CLI run

function toBars(rows: { t: number; o: number; h: number; l: number; c: number; v: number; tbv: number | null }[]): OHLCV[] {
  return rows.map((r) => ({
    timestamp: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v, takerBuyVolume: r.tbv ?? undefined,
  }));
}

async function verifiedHash(datasetDir: string): Promise<string> {
  const v = await verifyManifest(datasetDir);
  if (!v.ok) throw new Error(`Manifest verification failed: ${v.mismatches.join(', ')}`);
  return loadManifest(datasetDir).datasetHash;
}

async function exportSignals(opts: CliOptions, rule: 's1' | 's2'): Promise<void> {
  const hash = await verifiedHash(opts.datasetDir);
  const data: Record<string, SymbolBars> = {};
  for (const symbol of SIGNAL_SYMBOLS) {
    const perp = loadPerp(opts.datasetDir, symbol, '1h', 'klines');
    const funding = loadFunding(opts.datasetDir, symbol);
    data[symbol] = { bars: toBars(perp.rows), settlements: funding.rows };
  }
  const set = signalTranches(rule, data);
  const summary = baseSummary(rule, set, hash, EXPORT_SPAN.from);
  summary.warmup_note = 'none: the preview filters bars to the span before computing signals, and so does this export';
  writeExport(opts.out, set.tranches, summary);
}

async function exportC1(opts: CliOptions): Promise<void> {
  const hash = await verifiedHash(opts.datasetDir);
  const rows: ScoreRow[] = [];
  let firstCandle = Infinity;
  for (const symbol of NV1_SYMBOLS) {
    const candles = loadCandles(opts.datasetDir, symbol, '1h').rows;
    if (candles.length > 0) firstCandle = Math.min(firstCandle, candles[0].t);
    const scored = c1Scores(candles);
    for (let i = 0; i < scored.t.length; i++) {
      const s = scored.score[i];
      rows.push({ symbol, t: scored.t[i], close: scored.close[i], score: Number.isFinite(s) ? s : null });
    }
  }
  const set = c1Tranches(rows);
  const summary = baseSummary('c1', set, hash, Number.isFinite(firstCandle) ? firstCandle : EXPORT_SPAN.from);
  summary.costs = { fee_taker: 0.0005, fee_maker: null, slippage_bps: 3, round_trip: NV1_C1.costPct / 100 };
  summary.price_source_note =
    'prices are SPOT 1h closes (the rule\'s native prices). The 29b reader maps entry and exit times to perp 5m opens for the book, a disclosed price-source change';
  summary.warmup_note =
    'scores use every spot candle the default loader returns (spot 1h from the end of holdout A, 2021-10-14, as warm-up before the span, see warmup_from); older history stays unread, so a recursive indicator can differ slightly from the Round 1 scores computed from 2017. Holdout H is not read (perp intraday before 2022-01-01 is clipped by the loader)';
  writeExport(opts.out, set.tranches, summary);
}

async function exportV8(opts: CliOptions, rule: 'v8-1h' | 'v8-4h'): Promise<void> {
  const interval = rule === 'v8-1h' ? '1h' : '4h';
  const args = v8HarnessArgs(interval, opts.datasetDir, join(opts.out, 'harness-report.json'));
  const report = await runStrategyHarness(args);
  const perp: Record<string, OHLCV[]> = {};
  for (const symbol of DIRECTION_EXIT_SYMBOLS) {
    perp[symbol] = toBars(loadPerp(opts.datasetDir, symbol, interval, 'klines').rows);
  }
  const set = v8Tranches(rule, report, perp);
  const summary = baseSummary(rule, set, report.datasetManifestHash, V8_HARNESS_START);
  summary.warmup_note =
    'the harness reads spot from 2021-10-01 as warm-up before the span (warmup_from); perp 5m to 4h before 2022-01-01 is clipped by the loader, so holdout H is not read';
  const tf = report.costs.takerFeePercent / 100;
  summary.costs = {
    fee_taker: tf,
    fee_maker: report.costs.makerFeePercent / 100,
    slippage_bps: report.costs.slippageBps,
    round_trip: 2 * (tf + report.costs.slippageBps / 10_000),
  };
  summary.label = V8_LABEL;
  summary.harness = {
    family: 'dx-d0', fix_params: 'exit=1,k=1', price: 'perp', fee_profile: report.feeProfile, funding: 'settlements',
    eval_from: ISO(EXPORT_SPAN.from), end: ISO(EXPORT_SPAN.to - 1), report: 'harness-report.json',
  };
  const confirmFrom = Date.UTC(2025, 0, 1);
  const confirm = set.tranches
    .map((t, i) => ({ t, net: set.nativeNets[i] }))
    .filter((x) => x.t.entry_ms >= confirmFrom)
    .map((x) => x.net);
  summary.parity = {
    ...(summary.parity as Record<string, unknown>),
    confirmation_overlap: {
      from: ISO(confirmFrom),
      to_exclusive: ISO(EXPORT_SPAN.to),
      export_trades: confirm.length,
      export_mean_net: mean(confirm),
      note: 'the recorded value runs to 2026-10-09, so equality is not expected',
    },
  };
  summary.exit_price_unavailable = set.tranches.filter((t) => t.exit_price === null).length;
  summary.exit_price_note =
    'the report keeps times, side, net pnl and exit reason, not fills: horizon (time_stop) exits take the bar close at exit time; other exits stay null';
  summary.entry_price_note = 'entry price is the perp open at entryTime (the harness fill adds slippage on top, which is in the net)';
  writeExport(opts.out, set.tranches, summary);
}

async function exportRv(opts: CliOptions): Promise<void> {
  if (!opts.resolutions) throw new Error('rv-v1 needs --resolutions FILE (the reviewed funding resolutions, re-checked against REST)');
  const { verifyResolutions } = await import('./rv-resolutions');
  const { fetchFundingHistory } = await import('@/lib/snapshot-backfill');
  const verified = await verifyResolutions(readFileSync(opts.resolutions), fetchFundingHistory);
  const built = await buildRvPanel(opts.datasetDir, rvSpan(), verified);
  const steps = rvV1TakerSteps(built.panel);
  const tranches = rvTranches(built.panel, steps);
  const stats = rvStepStats(steps);
  const summary = baseSummary('rv-v1', { tranches, nativeNets: steps.map((s) => s.ret) }, built.meta.manifestHash, EXPORT_SPAN.from);
  summary.n_tranches = tranches.length;
  summary.mean_net_native = stats.mean;
  summary.costs = {
    fee_taker: RV_V1.costs.takerFee,
    fee_maker: RV_V1.costs.makerFee,
    slippage_bps: RV_V1.costs.takerSlippageBps,
    round_trip: 2 * (RV_V1.costs.takerFee + RV_V1.costs.takerSlippageBps / 10_000),
  };
  summary.n_steps = stats.n;
  summary.sharpe_ann = stats.sharpeAnn;
  summary.panel = {
    first_bar: ISO(built.panel.t[0]), last_bar: ISO(built.panel.t[built.panel.t.length - 1]), bars: built.panel.t.length,
    panel_sha256: built.meta.panelSha256, resolutions_sha256: verified.sha256,
  };
  summary.warmup_note =
    'no history before 2022-01-01: the first 42 panel bars are burn-in inside the span, the first fill is bar 43 (2022-01-15 00:00 UTC)';
  summary.dataset_note =
    'buildRvPanel HALTs on unrepaired data: use the repaired export (~/rv2-ds) with the reviewed resolutions file. readPanelSources loads whole files, but only the span grid is used';
  summary.parity = {
    ...parityOf('rv-v1', stats.n, null),
    recorded_sharpe_ann: NATIVE_REFERENCE['rv-v1'].sharpe,
    export_sharpe_ann: stats.sharpeAnn,
    sharpe_diff: stats.sharpeAnn === null ? null : stats.sharpeAnn - NATIVE_REFERENCE['rv-v1'].sharpe,
    note: 'recorded span is 2022-01-15 to 2026-10-13, the export ends before 2026-07-01',
  };
  writeExport(opts.out, tranches, summary);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const opts = parseCliArgs(argv);
  switch (opts.rule) {
    case 's1':
    case 's2':
      return exportSignals(opts, opts.rule);
    case 'c1':
      return exportC1(opts);
    case 'v8-1h':
    case 'v8-4h':
      return exportV8(opts, opts.rule);
    case 'rv-v1':
      return exportRv(opts);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
