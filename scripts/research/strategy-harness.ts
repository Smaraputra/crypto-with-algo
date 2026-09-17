/**
 * Strategy validation harness CLI: for one strategy family and interval,
 * runs C4a's walk-forward (strategy-walk-forward.ts) across the requested
 * symbols, pools the result through strategy-gates.ts's fixed validation
 * protocol, and writes a schema-validated StrategyReport (report-schema.ts).
 * This is the CLI research agents run for Phase 4 of the strategy research
 * program; the orchestrator validates, grounds, and spot-checks its output.
 *
 * Usage:
 *   npx tsx scripts/research/strategy-harness.ts --family control --interval 1h
 *   npx tsx scripts/research/strategy-harness.ts --family control --interval 5m \
 *     --symbols BTCUSDT,ETHUSDT --windows 8 --bootstrap-n 500
 *   npx tsx scripts/research/strategy-harness.ts \
 *     --cell BTCUSDT:0 --report data/research/reports/strategy-control-1h-....json
 *
 * Flags:
 *   --family <name>            required (a key of STRATEGY_FAMILIES), except
 *                               with --cell --report, which reads it from
 *                               the report; if passed there too, it must
 *                               agree with the report's own family
 *   --interval <interval>      required (e.g. 1h, 5m, 4h); same --cell
 *                               --report exception and agreement rule as
 *                               --family
 *   --symbols <a,b,c>          default: the dataset manifest's symbols
 *   --start / --end <ISO>      inclusive candle/snapshot range; HTF warmup
 *                               candles before --start are kept regardless
 *   --dataset-dir <dir>        default: data/research
 *   --out <file>               default: data/research/reports/strategy-<family>-<interval>-<taskId>.json
 *   --task-id <id>             default: strategy-<family>-<interval>-<UTC yyyymmddHHMM>
 *   --windows <n>              default: 6
 *   --train-fraction <f>       default: 0.4
 *   --window-mode <mode>       rolling (default) or anchored
 *   --seed <n>                 default: 42 (bootstrap and benchmark seed)
 *   --bootstrap-n <n>          default: 1000
 *   --benchmark-n <n>          default: 200
 *   --no-benchmark             disable the random-entry benchmark entirely
 *   --trials <n>               default: gridCells * number of STRATEGY_FAMILIES
 *   --stress-fee-mult <f>      default: 1.5
 *   --stress-slippage-mult <f> default: 2
 *   --allow-lockbox            read data at/after the 2026-07-01 lockbox
 *   --expect-manifest-hash <h> abort unless the loaded dataset matches
 *   --cell SYMBOL:WINDOW       with --report <file>: spot-check one window,
 *                               print { symbol, window, trades, expectancyPercent }
 *                               to stdout, write nothing
 *
 * The eight validation gates (strategy-gates.ts), thresholds fixed by the
 * research program's controller:
 *   sample     out-of-sample trade count >= 100 (300 for 5m)
 *   expectancy pooled expectancy and its bootstrap CI low bound both > 0
 *   windows    share of (symbol, window) pairs with positive OOS expectancy >= 0.6
 *   symbols    share of symbols with a positive pooled OOS mean >= 0.7
 *   timing     pooled random-entry-benchmark p-value < 0.05
 *   trials     deflated Sharpe probability >= 0.95
 *   plateau    parameter plateau score >= 0.6 (not applicable for one cell)
 *   stress     stressed-cost pooled expectancy > 0
 *
 * Fixed decisions this harness does not revisit: in-sample cell selection is
 * C4a's rule (highest in-sample expectancy among cells at or above
 * minIsTrades trades, earliest index on a tie); 5m and 15m read the symbol's
 * 1h snapshots exactly as live scoring does (mapToSnapshotInterval); funding
 * is enabled only when every loaded symbol has snapshot rows -- a mix of
 * covered and uncovered symbols aborts rather than silently running with
 * funding off for some symbols and on for others; the objective throughout
 * is net expectancy per trade after all costs.
 *
 * Runtime note: strategy-walk-forward.ts's bar loop measured about 2.6
 * microseconds per bar, and one random-entry benchmark run (200 iterations)
 * measured about 10 ms, on 17,000 1h bars (see strategy-walk-forward.ts's
 * own test fixtures for the benchmark methodology).
 * Acceptance run wall time: recorded by the controller after merge review.
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { OHLCV } from '@/types/market';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { LeanSnapshot } from '@/lib/backtest/snapshot-series';
import type { HtfInput } from '@/lib/backtest/optimized-engine';
import { studyCostConfig } from '@/lib/backtest/cost-model';
import { mapToSnapshotInterval } from '@/lib/backtest/snapshot-series';
import { getConfirmationInterval } from '@/lib/signals/htf';
import { loadCandles, loadManifest, loadSnapshots, verifyManifest } from './load-dataset';
import { toLeanSnapshot, toOHLCV, styleForInterval } from './factors';
import { STRATEGY_FAMILIES, expandGrid } from './strategy-families';
import {
  resolveWindowConfig,
  runStrategyWalkForward,
  type OosTrade,
  type StrategyWalkForwardResult,
  type WindowResult,
} from './strategy-walk-forward';
import { evaluateStrategyGates, finiteOr, poolStrategyResults, toFinite, VALIDATION_PROTOCOL } from './strategy-gates';
import { validateStrategyReport, type StrategyReport } from './report-schema';

const MIN_IS_TRADES = 10;

export interface StrategyHarnessArgs {
  /** Required unless both --cell and --report are given, in which case
   * runCell reads family from the report; when passed anyway, runCell
   * requires it to agree with the report's own family. */
  family?: string;
  /** Same optionality/agreement rule as family, for --interval. */
  interval?: string;
  symbols?: string[];
  start?: number;
  end?: number;
  datasetDir: string;
  out: string;
  taskId: string;
  windows: number;
  trainFraction: number;
  windowMode: 'rolling' | 'anchored';
  seed: number;
  bootstrapN: number;
  benchmarkN: number;
  noBenchmark: boolean;
  trials: number;
  stressFeeMult: number;
  stressSlippageMult: number;
  allowLockbox: boolean;
  expectManifestHash?: string;
  cell?: { symbol: string; window: number };
  reportPath?: string;
}

export interface StrategyCellResult {
  symbol: string;
  window: number;
  trades: number;
  expectancyPercent: number | null;
}

function parseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseIsoFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid --${name} date: ${value}`);
  }
  return ms;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** family/interval are omittable in --cell --report mode, where the run's
 * own taskId/out are never read (runCell never touches them); falls back to
 * a family/interval-free stamp in that case. */
function defaultTaskId(family: string | undefined, interval: string | undefined, now: Date): string {
  const stamp =
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
  if (family !== undefined && interval !== undefined) {
    return `strategy-${family}-${interval}-${stamp}`;
  }
  return `strategy-cell-${stamp}`;
}

function parseCell(value: string): { symbol: string; window: number } {
  const parts = value.split(':');
  if (parts.length !== 2) {
    throw new Error(`Invalid --cell value: ${value}, expected SYMBOL:WINDOW`);
  }
  const [symbol, windowStr] = parts;
  const window = Number(windowStr);
  if (!symbol || !Number.isInteger(window) || window < 0) {
    throw new Error(`Invalid --cell value: ${value}, expected SYMBOL:WINDOW`);
  }
  return { symbol, window };
}

const BOOLEAN_FLAGS = new Set(['allow-lockbox', 'no-benchmark']);

const VALUE_FLAGS = new Set([
  'family',
  'interval',
  'symbols',
  'start',
  'end',
  'dataset-dir',
  'out',
  'task-id',
  'windows',
  'train-fraction',
  'window-mode',
  'seed',
  'bootstrap-n',
  'benchmark-n',
  'trials',
  'stress-fee-mult',
  'stress-slippage-mult',
  'expect-manifest-hash',
  'cell',
  'report',
]);

/** Pure CLI argument parsing. `now` is injectable so default-taskId tests are deterministic. */
export function parseArgs(argv: string[], now: Date = new Date()): StrategyHarnessArgs {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      booleans.add(key);
      continue;
    }
    if (!VALUE_FLAGS.has(key)) {
      throw new Error(`Unknown flag --${key}`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }
    flags.set(key, value);
    i++;
  }

  // --family/--interval are required except in --cell --report mode, where
  // runCell reads both from the report instead (and, if either is passed
  // anyway, requires it to agree with the report -- see runCell below).
  const cellReportMode = flags.has('cell') && flags.has('report');

  const family = flags.get('family');
  if (family !== undefined) {
    if (!STRATEGY_FAMILIES[family]) {
      throw new Error(
        `Unknown --family "${family}", expected one of: ${Object.keys(STRATEGY_FAMILIES).join(', ')}`
      );
    }
  } else if (!cellReportMode) {
    throw new Error('--family is required');
  }

  const interval = flags.get('interval');
  if (interval === undefined && !cellReportMode) {
    throw new Error('--interval is required');
  }

  const windowMode = flags.get('window-mode') ?? 'rolling';
  if (windowMode !== 'rolling' && windowMode !== 'anchored') {
    throw new Error(`Invalid --window-mode "${windowMode}", expected rolling or anchored`);
  }

  const taskId = flags.get('task-id') ?? defaultTaskId(family, interval, now);
  const out =
    flags.get('out') ??
    (family !== undefined && interval !== undefined
      ? `data/research/reports/strategy-${family}-${interval}-${taskId}.json`
      : `data/research/reports/strategy-cell-${taskId}.json`);

  const gridCells = family !== undefined ? expandGrid(STRATEGY_FAMILIES[family]).length : 0;
  const defaultTrials = gridCells * Object.keys(STRATEGY_FAMILIES).length;

  return {
    family,
    interval,
    symbols: flags.has('symbols') ? parseList(flags.get('symbols')!) : undefined,
    start: parseIsoFlag(flags.get('start'), 'start'),
    end: parseIsoFlag(flags.get('end'), 'end'),
    datasetDir: flags.get('dataset-dir') ?? 'data/research',
    out,
    taskId,
    windows: flags.has('windows') ? Number(flags.get('windows')) : 6,
    trainFraction: flags.has('train-fraction') ? Number(flags.get('train-fraction')) : 0.4,
    windowMode,
    seed: flags.has('seed') ? Number(flags.get('seed')) : 42,
    bootstrapN: flags.has('bootstrap-n') ? Number(flags.get('bootstrap-n')) : VALIDATION_PROTOCOL.bootstrap.iterations,
    benchmarkN: flags.has('benchmark-n') ? Number(flags.get('benchmark-n')) : 200,
    noBenchmark: booleans.has('no-benchmark'),
    trials: flags.has('trials') ? Number(flags.get('trials')) : defaultTrials,
    stressFeeMult: flags.has('stress-fee-mult')
      ? Number(flags.get('stress-fee-mult'))
      : VALIDATION_PROTOCOL.stress.feeMultiplier,
    stressSlippageMult: flags.has('stress-slippage-mult')
      ? Number(flags.get('stress-slippage-mult'))
      : VALIDATION_PROTOCOL.stress.slippageMultiplier,
    allowLockbox: booleans.has('allow-lockbox'),
    expectManifestHash: flags.get('expect-manifest-hash'),
    cell: flags.has('cell') ? parseCell(flags.get('cell')!) : undefined,
    reportPath: flags.get('report'),
  };
}

function inRange(t: number, start: number | undefined, end: number | undefined): boolean {
  if (start !== undefined && t < start) return false;
  if (end !== undefined && t > end) return false;
  return true;
}

interface SymbolInputs {
  symbol: string;
  candles: OHLCV[];
  snapshots: LeanSnapshot[];
  snapshotRows: number;
  htfInput: HtfInput | undefined;
  htfBars: number;
  lockboxApplied: boolean;
}

/**
 * Loads one symbol's candles, snapshots, and HTF confirmation candles exactly
 * as the harness's per-symbol loop and its --cell spot check both need them.
 * Main candles and snapshots are filtered to [start, end]; HTF candles are
 * filtered only to t <= end, so bars before --start stay available as
 * warmup (see resolveWindowConfig/prepareBacktest's own warmup handling).
 */
function loadSymbolInputs(
  datasetDir: string,
  symbol: string,
  interval: string,
  style: TradingStyle,
  snapshotInterval: string,
  opts: { allowLockbox: boolean; start?: number; end?: number }
): SymbolInputs {
  const candleResult = loadCandles(datasetDir, symbol, interval, { allowLockbox: opts.allowLockbox });
  const candles = candleResult.rows.filter((r) => inRange(r.t, opts.start, opts.end)).map(toOHLCV);

  const snapshotPath = join(datasetDir, 'snapshots', symbol, `${snapshotInterval}.jsonl.gz`);
  let snapshots: LeanSnapshot[] = [];
  if (existsSync(snapshotPath)) {
    const snapshotResult = loadSnapshots(datasetDir, symbol, snapshotInterval, { allowLockbox: opts.allowLockbox });
    snapshots = snapshotResult.rows.filter((r) => inRange(r.t, opts.start, opts.end)).map(toLeanSnapshot);
    if (snapshotInterval !== interval) {
      console.error(`[strategy-harness] ${symbol}: using ${snapshotInterval} snapshots for ${interval} candles`);
    }
  }

  const htfInterval = getConfirmationInterval(interval, style);
  let htfInput: HtfInput | undefined;
  let htfBars = 0;
  if (htfInterval) {
    const htfPath = join(datasetDir, 'candles', symbol, `${htfInterval}.jsonl.gz`);
    if (existsSync(htfPath)) {
      const htfResult = loadCandles(datasetDir, symbol, htfInterval, { allowLockbox: opts.allowLockbox });
      const htfCandles = htfResult.rows.filter((r) => opts.end === undefined || r.t <= opts.end).map(toOHLCV);
      htfInput = { candles: htfCandles, interval: htfInterval };
      htfBars = htfCandles.length;
    } else {
      console.error(`[strategy-harness] ${symbol}: no htf candles file for ${htfInterval}, htfBars=0`);
    }
  }

  return {
    symbol,
    candles,
    snapshots,
    snapshotRows: snapshots.length,
    htfInput,
    htfBars,
    lockboxApplied: candleResult.lockboxApplied,
  };
}

function buildPooledOos(windows: WindowResult[]): StrategyReport['perSymbol'][number]['pooledOos'] {
  const trades: OosTrade[] = windows.flatMap((w) => w.oosTrades);
  const n = trades.length;
  if (n === 0) {
    return { trades: 0, expectancyPercent: null, winRate: null };
  }
  const meanPnlPercent = trades.reduce((s, t) => s + t.pnlPercent, 0) / n;
  const winCount = trades.filter((t) => t.pnl > 0).length;
  return {
    trades: n,
    expectancyPercent: toFinite(meanPnlPercent),
    winRate: toFinite(winCount / n),
  };
}

function buildWindowReport(w: WindowResult): StrategyReport['perSymbol'][number]['windows'][number] {
  return {
    index: w.index,
    trainStart: w.trainStart,
    trainEnd: w.trainEnd,
    testStart: w.testStart,
    testEnd: w.testEnd,
    selectedParams: w.selectedParams,
    skippedReason: w.skippedReason,
    isCells: w.isCells.map((c) => ({
      params: c.params,
      trades: c.trades,
      expectancyPercent: toFinite(c.expectancyPercent),
      expectancyR: c.expectancyR === null ? null : toFinite(c.expectancyR),
      perTradeSharpe: toFinite(c.perTradeSharpe),
      winRate: toFinite(c.winRate),
      profitFactor: toFinite(c.profitFactor),
      maxDrawdownPercent: toFinite(c.maxDrawdownPercent),
    })),
    oosCells: w.oosCells.map((oc) => ({
      params: oc.params,
      trades: oc.trades,
      expectancyPercent: toFinite(oc.expectancyPercent),
    })),
    oos: w.oos
      ? {
          trades: w.oos.trades,
          expectancyPercent: toFinite(w.oos.expectancyPercent),
          expectancyR: w.oos.expectancyR === null ? null : toFinite(w.oos.expectancyR),
          winRate: toFinite(w.oos.winRate),
          profitFactor: toFinite(w.oos.profitFactor),
          maxDrawdownPercent: toFinite(w.oos.maxDrawdownPercent),
          medianHoldBars: toFinite(w.oos.medianHoldBars),
          fees: finiteOr(w.oos.fees, 0),
          slippageCost: finiteOr(w.oos.slippageCost, 0),
          fundingCost: finiteOr(w.oos.fundingCost, 0),
        }
      : null,
    stress: w.stress ? { trades: w.stress.trades, expectancyPercent: toFinite(w.stress.expectancyPercent) } : null,
    benchmark: w.benchmark
      ? {
          iterations: w.benchmark.iterations,
          seed: w.benchmark.seed,
          meanRandom: finiteOr(w.benchmark.meanRandom, 0),
          sdRandom: finiteOr(w.benchmark.sdRandom, 0),
          pValue: toFinite(w.benchmark.pValue),
          referenceTrades: w.benchmark.referenceTrades,
        }
      : null,
  };
}

function resolveCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function fmtValue(value: number | null, decimals = 4): string {
  return value === null ? '-' : value.toFixed(decimals);
}

function formatReport(report: StrategyReport): string {
  const lines: string[] = [];

  lines.push(
    `family=${report.family} style=${report.style} interval=${report.interval} symbols=${report.symbols.length} ` +
      `cells=${report.gridCells} trials=${report.trials} lockbox=${report.lockboxApplied} ` +
      `datasetHash=${report.datasetManifestHash.slice(0, 12)}`
  );

  const header = ['gate', 'pass', 'value', 'threshold', 'note'].map((h) => h.padEnd(12)).join('');
  lines.push(header);
  for (const gate of report.gates) {
    lines.push(
      [
        gate.name.padEnd(12),
        (gate.pass ? 'yes' : 'no').padEnd(12),
        fmtValue(gate.value).padEnd(12),
        String(gate.threshold).padEnd(12),
        gate.note ?? '',
      ].join('')
    );
  }

  const ci = report.pooled.bootstrapCi95
    ? `[${report.pooled.bootstrapCi95[0].toFixed(4)}, ${report.pooled.bootstrapCi95[1].toFixed(4)}]`
    : '-';
  lines.push(
    `pooled: trades=${report.pooled.n} expectancy=${fmtValue(report.pooled.expectancyPercent)}% ` +
      `CI95=${ci} winRate=${fmtValue(report.pooled.winRate)} medianHold=${fmtValue(report.pooled.medianHoldBars, 1)}`
  );

  for (const s of report.perSymbol) {
    lines.push(`${s.symbol}: trades=${s.pooledOos.trades} expectancy=${fmtValue(s.pooledOos.expectancyPercent)}%`);
  }

  const failedGates = report.gates.filter((g) => !g.pass).map((g) => g.name);
  lines.push(report.pass ? 'RESULT: PASS' : `RESULT: FAIL (${failedGates.join(', ')})`);

  return lines.join('\n');
}

/**
 * Full pipeline: verifies the dataset, loads every requested symbol, runs
 * C4a's walk-forward per symbol, pools the result through strategy-gates.ts,
 * assembles and validates a StrategyReport, writes it to --out, and prints a
 * summary to stdout (progress goes to stderr only).
 */
export async function runStrategyHarness(args: StrategyHarnessArgs): Promise<StrategyReport> {
  const startedAt = Date.now();

  // Required for a real run (parseArgs already enforces this outside --cell
  // --report mode, but runStrategyHarness never runs in that mode, so it
  // re-asserts here for callers that build args without parseArgs).
  if (!args.family) {
    throw new Error('--family is required');
  }
  if (!args.interval) {
    throw new Error('--interval is required');
  }
  const familyName = args.family;
  const interval = args.interval;

  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  if (args.expectManifestHash !== undefined && manifest.datasetHash !== args.expectManifestHash) {
    throw new Error(
      `Dataset manifest hash mismatch: loaded dataset has ${manifest.datasetHash}, expected ${args.expectManifestHash}`
    );
  }

  const style = styleForInterval(interval);
  const costs = studyCostConfig(interval);
  const family = STRATEGY_FAMILIES[familyName];
  if (!family) {
    throw new Error(
      `Unknown --family "${familyName}", expected one of: ${Object.keys(STRATEGY_FAMILIES).join(', ')}`
    );
  }
  const cells = expandGrid(family);

  const symbols = args.symbols && args.symbols.length > 0 ? args.symbols : manifest.symbols;
  const snapshotInterval = mapToSnapshotInterval(interval);

  console.error(`[strategy-harness] family=${familyName} interval=${interval} symbols=${symbols.join(',')}`);

  const perSymbolInputs: SymbolInputs[] = [];
  for (const symbol of symbols) {
    console.error(`[strategy-harness] loading ${symbol}...`);
    perSymbolInputs.push(
      loadSymbolInputs(args.datasetDir, symbol, interval, style, snapshotInterval, {
        allowLockbox: args.allowLockbox,
        start: args.start,
        end: args.end,
      })
    );
  }

  const withFunding = perSymbolInputs.filter((s) => s.snapshotRows > 0);
  let fundingEnabled: boolean;
  if (withFunding.length === perSymbolInputs.length) {
    fundingEnabled = true;
  } else if (withFunding.length === 0) {
    fundingEnabled = false;
  } else {
    const missing = perSymbolInputs.filter((s) => s.snapshotRows === 0).map((s) => s.symbol);
    throw new Error(
      `Mixed snapshot coverage: ${missing.join(', ')} have no ${snapshotInterval} snapshot rows while others do; pass --symbols to exclude them`
    );
  }
  const snapshotSource = fundingEnabled ? snapshotInterval : null;
  const lockboxApplied = perSymbolInputs.every((s) => s.lockboxApplied);

  const results: StrategyWalkForwardResult[] = [];
  for (const input of perSymbolInputs) {
    const windowMs: number[] = [];
    const result = runStrategyWalkForward({
      candles: input.candles,
      symbol: input.symbol,
      interval,
      style,
      family,
      cells,
      snapshots: input.snapshots.length > 0 ? input.snapshots : undefined,
      htfInput: input.htfInput,
      costs: {
        feePercent: costs.feePercent,
        makerFeePercent: costs.makerFeePercent as number,
        takerFeePercent: costs.takerFeePercent as number,
        slippageBps: costs.slippageBps as number,
      },
      fundingEnabled,
      windows: { count: args.windows, trainFraction: args.trainFraction, mode: args.windowMode },
      minIsTrades: MIN_IS_TRADES,
      stress: { feeMultiplier: args.stressFeeMult, slippageMultiplier: args.stressSlippageMult },
      benchmark: args.noBenchmark ? null : { iterations: args.benchmarkN, seed: args.seed },
      onWindow: ({ index, ms }) => {
        windowMs[index] = ms;
      },
    });

    result.windows.forEach((w, i) => {
      const trades = w.oos?.trades ?? 0;
      const expectancy = w.oos?.expectancyPercent ?? 0;
      console.error(
        `[strategy-harness] ${input.symbol} window ${i + 1}/${result.windows.length}: ${trades} trades, ` +
          `expectancy ${expectancy.toFixed(4)}%, ${windowMs[i]} ms`
      );
    });

    results.push(result);
  }

  const pooled = poolStrategyResults(results, {
    interval,
    cells,
    familyCount: Object.keys(STRATEGY_FAMILIES).length,
    trialsOverride: args.trials,
    bootstrapIterations: args.bootstrapN,
    seed: args.seed,
  });
  const { gates, pass } = evaluateStrategyGates(pooled, interval);

  const perSymbolReports: StrategyReport['perSymbol'] = results.map((result, i) => ({
    symbol: result.symbol,
    snapshotRows: perSymbolInputs[i].snapshotRows,
    htfBars: perSymbolInputs[i].htfBars,
    windowConfig: result.windowConfig,
    windows: result.windows.map(buildWindowReport),
    pooledOos: buildPooledOos(result.windows),
  }));

  const report: StrategyReport = {
    schemaVersion: 1,
    taskId: args.taskId,
    datasetManifestHash: manifest.datasetHash,
    lockboxApplied,
    family: familyName,
    style,
    interval,
    symbols,
    dateRange: { startMs: args.start ?? null, endMs: args.end ?? null },
    gridCells: cells.length,
    trials: pooled.trials,
    snapshotSource,
    costs: {
      feePercent: costs.feePercent,
      makerFeePercent: costs.makerFeePercent as number,
      takerFeePercent: costs.takerFeePercent as number,
      slippageBps: costs.slippageBps as number,
      fundingEnabled,
    },
    windowConfig: { mode: args.windowMode, trainFraction: args.trainFraction, count: args.windows, minIsTrades: MIN_IS_TRADES },
    stress: { feeMultiplier: args.stressFeeMult, slippageMultiplier: args.stressSlippageMult },
    benchmark: { enabled: !args.noBenchmark, iterations: args.benchmarkN, seed: args.seed },
    bootstrap: pooled.bootstrap,
    perSymbol: perSymbolReports,
    pooled,
    gates,
    pass,
    computedAt: new Date().toISOString(),
    gitCommit: resolveCommit(),
    durationMs: Date.now() - startedAt,
  };

  const validated = validateStrategyReport(report);
  if (!validated.ok) {
    throw new Error(`strategy-harness report failed schema validation:\n${validated.issues.join('\n')}`);
  }

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(validated.data, null, 2) + '\n', 'utf8');
  console.error(`[strategy-harness] wrote ${args.out}`);

  console.log(formatReport(validated.data));

  return validated.data;
}

/**
 * Spot check: recomputes one (symbol, window) cell from a previously written
 * StrategyReport and prints { symbol, window, trades, expectancyPercent } as
 * JSON to stdout. Writes no file. Reuses the report's own family, interval,
 * window geometry, costs, funding, stress config, and lockbox setting, so
 * the recomputation reproduces exactly the run the report describes rather
 * than whatever the CLI invocation's own flags happen to say.
 */
export async function runCell(args: StrategyHarnessArgs): Promise<StrategyCellResult> {
  if (!args.cell) {
    throw new Error('runCell requires args.cell');
  }
  if (!args.reportPath) {
    throw new Error('runCell requires --report <file>');
  }

  const raw = JSON.parse(await readFile(args.reportPath, 'utf8'));
  const validated = validateStrategyReport(raw);
  if (!validated.ok) {
    throw new Error(`--report ${args.reportPath} failed schema validation:\n${validated.issues.join('\n')}`);
  }
  const report = validated.data;

  // --family/--interval are optional in --cell --report mode (both are read
  // from the report below); if passed anyway, they must agree with what the
  // report itself recorded, or the spot check would silently answer a
  // different question than the one the flags asked.
  if (args.family !== undefined && args.family !== report.family) {
    throw new Error(`--family "${args.family}" disagrees with the report's family "${report.family}"`);
  }
  if (args.interval !== undefined && args.interval !== report.interval) {
    throw new Error(`--interval "${args.interval}" disagrees with the report's interval "${report.interval}"`);
  }

  const family = STRATEGY_FAMILIES[report.family];
  if (!family) {
    throw new Error(`Report names unknown family "${report.family}"`);
  }

  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  const expectManifestHash = args.expectManifestHash ?? report.datasetManifestHash;
  if (manifest.datasetHash !== expectManifestHash) {
    throw new Error(
      `Dataset manifest hash mismatch: loaded dataset has ${manifest.datasetHash}, expected ${expectManifestHash}`
    );
  }

  const { symbol, window } = args.cell;
  const symbolReport = report.perSymbol.find((p) => p.symbol === symbol);
  if (!symbolReport) {
    throw new Error(`Symbol "${symbol}" not present in report ${args.reportPath}`);
  }
  const windowReport = symbolReport.windows[window];
  if (!windowReport) {
    throw new Error(`Window ${window} not present for symbol "${symbol}" in report ${args.reportPath}`);
  }
  if (windowReport.selectedParams === null) {
    throw new Error(
      `Window ${window} for symbol "${symbol}" was skipped in the report (${windowReport.skippedReason ?? 'no reason recorded'})`
    );
  }

  const style = styleForInterval(report.interval);
  const snapshotInterval = mapToSnapshotInterval(report.interval);
  const start = report.dateRange.startMs ?? undefined;
  const end = report.dateRange.endMs ?? undefined;
  const allowLockbox = !report.lockboxApplied;

  const input = loadSymbolInputs(args.datasetDir, symbol, report.interval, style, snapshotInterval, {
    allowLockbox,
    start,
    end,
  });

  const resolved = resolveWindowConfig(input.candles, symbol, report.interval, style, {
    count: report.windowConfig.count,
    trainFraction: report.windowConfig.trainFraction,
    mode: report.windowConfig.mode,
  });
  const actualWindowConfig = {
    trainBars: resolved.trainBars,
    testWindowBars: resolved.testWindowBars,
    purgeGapBars: resolved.purgeGapBars,
    stepSizeBars: resolved.stepSizeBars,
    mode: resolved.mode,
    count: resolved.count,
  };
  // Field-by-field, not JSON.stringify equality: the two objects are built
  // by separate object literals (one here, one already sitting in the
  // parsed report), and stringify-equality would depend on key order rather
  // than on the six values actually mattering.
  const expectedWindowConfig = symbolReport.windowConfig;
  const windowConfigMatches =
    actualWindowConfig.trainBars === expectedWindowConfig.trainBars &&
    actualWindowConfig.testWindowBars === expectedWindowConfig.testWindowBars &&
    actualWindowConfig.purgeGapBars === expectedWindowConfig.purgeGapBars &&
    actualWindowConfig.stepSizeBars === expectedWindowConfig.stepSizeBars &&
    actualWindowConfig.mode === expectedWindowConfig.mode &&
    actualWindowConfig.count === expectedWindowConfig.count;
  if (!windowConfigMatches) {
    throw new Error(
      `Window geometry mismatch for symbol "${symbol}": report has ${JSON.stringify(expectedWindowConfig)}, ` +
        `recomputed ${JSON.stringify(actualWindowConfig)}`
    );
  }

  const result = runStrategyWalkForward({
    candles: input.candles,
    symbol,
    interval: report.interval,
    style,
    family,
    cells: [windowReport.selectedParams],
    snapshots: input.snapshots.length > 0 ? input.snapshots : undefined,
    htfInput: input.htfInput,
    costs: {
      feePercent: report.costs.feePercent,
      makerFeePercent: report.costs.makerFeePercent,
      takerFeePercent: report.costs.takerFeePercent,
      slippageBps: report.costs.slippageBps,
    },
    fundingEnabled: report.costs.fundingEnabled,
    windows: { count: report.windowConfig.count, trainFraction: report.windowConfig.trainFraction, mode: report.windowConfig.mode },
    minIsTrades: report.windowConfig.minIsTrades,
    stress: report.stress,
    benchmark: null,
  });

  const oos = result.windows[window]?.oos ?? null;
  const cellResult: StrategyCellResult = {
    symbol,
    window,
    trades: oos?.trades ?? 0,
    expectancyPercent: oos ? toFinite(oos.expectancyPercent) : null,
  };
  console.log(JSON.stringify(cellResult));
  return cellResult;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cell) {
    await runCell(args);
  } else {
    await runStrategyHarness(args);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
