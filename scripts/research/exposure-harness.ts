/**
 * CLI for the banded-exposure path: mirrors `strategy-harness.ts` in structure,
 * but drives `simulateExposure` instead of the discrete strategy engine.
 *
 * WHY A SEPARATE HARNESS AND NOT A FAMILY
 *
 * The engine cannot express a target exposure. `runBarLoop` holds one position
 * in two nullable slots, `EntryDecision` carries no size, `decideExit` returns
 * a bare boolean, and equity there is realized-only (`computeEquityAfterTrade`
 * at close sites), so there is no mark-to-market anywhere. A banded exposure is
 * nothing but a mark-to-market path, and all eight gates are downstream of
 * `BacktestResult.trades`, which this path does not produce. So it carries its
 * own gate module, its own report schema and its own harness.
 *
 * WHAT IT LOADS, AND THE VENUE DECISION
 *
 * Prices, funding and the factor column all come from the PERP series
 * (`loadPerp`). The returns must be perp because that is the venue the exposure
 * is actually held on, and funding only means anything against the prices the
 * position carries. The factor column is built on the same series rather than
 * on the spot candles every earlier phase used, which is a deliberate departure
 * with a real consequence: everything before this measured positioning on SPOT
 * closes, so this run evaluates the factor ON PERP PRICES and the IC study's
 * `1d h32 ic -0.218` is not a number the reports here can be read against. The
 * spot and perp grids are identical on this dataset (checked), so the two
 * differ in price only, not in alignment; the harness asserts the grids agree
 * anyway so a future dataset with a divergent grid fails loudly instead of
 * silently misaligning.
 *
 * SMOOTHING AND THE TRIM, WHICH ARE ONE FIX IN TWO PARTS
 *
 * See `exposure-walk-forward.ts`'s header for the full reasoning. In short:
 * `simulateExposure` owns `trailingMean`, so a window slice handed a non-zero
 * `smoothing` has no reading at its head, and one grid cell would mean two
 * different signals across the split. Two things are needed and either one
 * alone is inert:
 *
 *   1. Pre-smooth over the full series and pass `smoothing: 0` to the
 *      simulator, while still recording `smoothing` on the cell.
 *   2. Trim to `maxSmoothingWarmupBars(factorStart)`, NOT to `factorStart`. A
 *      trailing mean needs `smoothing` finite readings either way, so a run
 *      trimmed to the raw column's first reading still has a dead window head
 *      for another 31 bars.
 *
 * Both the full run and the `--cell` spot check apply the same trim; if they
 * diverged the spot check would check a different series than it reports on.
 *
 *   npx tsx scripts/research/exposure-harness.ts --interval 1d --factor positioningZ360
 *   npx tsx scripts/research/exposure-harness.ts --interval 1d --cell BTCUSDT:3 --report <file>
 *
 * Flags:
 *   --factor <column>          default positioningZ360
 *   --interval <iv>            required
 *   --symbols <a,b,...>        default: every symbol in the manifest
 *   --start / --end <ISO>      inclusive range
 *   --dataset-dir <dir>        default data/research
 *   --out <file>               default data/research/reports/exposure-<factor>-<interval>-<taskId>.json
 *   --task-id <id>             default exposure-<factor>-<interval>-<UTC yyyymmddHHMM>
 *   --windows <n>              default 6
 *   --train-fraction <f>       default 0.4
 *   --window-mode <mode>       rolling | anchored, default rolling
 *   --seed <n>                 default 42, also seeds the timing shuffle
 *   --bootstrap-n <n>          default 1000
 *   --timing-draws <n>         default 200
 *   --trials <n>               default 36 (one per grid cell)
 *   --stress-fee-mult <f>      default 1.5
 *   --stress-slippage-mult <f> default 2
 *   --fee-profile standard|bnb|promo-btc-eth-2026-07
 *                               default standard. The selection run is always
 *                               standard; the other profiles are sensitivity
 *                               reads, priced per symbol. The `--cell` spot
 *                               check reads the profile from the report, not
 *                               this flag.
 *   --allow-lockbox            read data from 2026-07-01 onward too
 *   --expect-manifest-hash <h> abort unless the dataset hash matches
 *   --cell SYMBOL:WINDOW       spot-check mode, needs --report
 *   --report <file>            the report --cell checks against
 */

import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OHLCV } from '@/types/market';
import { buildSnapshotSeries, mapToSnapshotInterval } from '@/lib/backtest/snapshot-series';
import { perPeriodSharpe } from '@/lib/stats/deflated-sharpe';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import {
  DEFAULT_FEE_PROFILE,
  FEE_PROFILE_NAMES,
  isFeeProfileName,
  studyCostConfig,
  type FeeProfileName,
} from '@/lib/backtest/cost-model';

import {
  EXPOSURE_GRID_CELL_COUNT,
  alignToSharedGrid,
  jointFactorStart,
  maxSmoothingWarmupBars,
  preSmooth,
  runExposureWalkForward,
  sliceSymbolInput,
} from './exposure-walk-forward';
import {
  EXPOSURE_PROTOCOL,
  evaluateExposureGates,
  poolExposureResults,
  type ExposureCellRun,
} from './exposure-gates';
import { simulateExposure, type ExposureSymbolInput } from './exposure-sim';
import { RESEARCH_COLUMNS, positioningColumn } from './research-columns';
import { toLeanSnapshot } from './factors';
import { loadCandles, loadManifest, loadPerp, loadSnapshots, verifyManifest } from './load-dataset';
import { validateExposureReport, type ExposureReport } from './report-schema';

type ExposurePerSymbolRow = ExposureReport['perSymbol'][number];
type ExposureWindowRow = ExposureReport['windows'][number];

/** Added to `--seed` for the timing shuffle, so the shuffle's stream and the
 * bootstrap's own (seeded from `options.seed` inside `bootstrapCi`) are not the
 * same generator. Matches the step the discrete harness already uses. */
export const TIMING_SEED_OFFSET = 1_000_000;

const DEFAULT_FACTOR = positioningColumn(360);

export interface ExposureHarnessArgs {
  factor?: string;
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
  timingDraws: number;
  trials: number;
  stressFeeMult: number;
  stressSlippageMult: number;
  feeProfile: FeeProfileName;
  allowLockbox: boolean;
  expectManifestHash?: string;
  cell?: { symbol: string; window: number };
  reportPath?: string;
}

const BOOLEAN_FLAGS = new Set(['allow-lockbox']);

const VALUE_FLAGS = new Set([
  'factor',
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
  'timing-draws',
  'trials',
  'stress-fee-mult',
  'stress-slippage-mult',
  'fee-profile',
  'expect-manifest-hash',
  'cell',
  'report',
]);

function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIsoFlag(raw: string | undefined, key: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid --${key} date: ${raw}`);
  return parsed;
}

function parseNumberFlag(
  raw: string | undefined,
  key: string,
  opts: { integer?: boolean } = {}
): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid --${key}: ${raw}`);
  if (opts.integer && !Number.isInteger(value)) throw new Error(`Invalid --${key}: ${raw}`);
  return value;
}

function parseCell(raw: string): { symbol: string; window: number } {
  const parts = raw.split(':');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid --cell value: ${raw}, expected SYMBOL:WINDOW`);
  }
  const window = Number(parts[1]);
  if (!Number.isInteger(window) || window < 0) {
    throw new Error(`Invalid --cell value: ${raw}, expected SYMBOL:WINDOW`);
  }
  return { symbol: parts[0].trim().toUpperCase(), window };
}

function parseFactor(raw: string): string {
  if (!RESEARCH_COLUMNS.includes(raw)) {
    throw new Error(`Unknown --factor "${raw}", expected one of: ${RESEARCH_COLUMNS.join(', ')}`);
  }
  return raw;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function defaultTaskId(factor: string, interval: string, now: Date): string {
  const stamp =
    `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}` +
    `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;
  return `exposure-${factor}-${interval}-${stamp}`;
}

export function parseArgs(argv: string[], now: Date = new Date()): ExposureHarnessArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, 'true');
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new Error(`Unknown flag --${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    flags.set(key, value);
    i++;
  }

  const cell = flags.has('cell') ? parseCell(flags.get('cell')!) : undefined;
  const reportPath = flags.get('report');
  const cellMode = cell !== undefined;

  const rawFactor = flags.get('factor');
  if (rawFactor !== undefined && !cellMode) parseFactor(rawFactor);
  const factor = cellMode ? undefined : (rawFactor ?? DEFAULT_FACTOR);

  const interval = flags.get('interval');
  if (!cellMode) {
    if (factor !== undefined && rawFactor === undefined) parseFactor(factor);
    if (interval === undefined) throw new Error('--interval is required');
  }

  const windows = parseNumberFlag(flags.get('windows'), 'windows', { integer: true }) ?? 6;
  const trainFraction = parseNumberFlag(flags.get('train-fraction'), 'train-fraction') ?? 0.4;
  const windowModeRaw = flags.get('window-mode') ?? 'rolling';
  if (windowModeRaw !== 'rolling' && windowModeRaw !== 'anchored') {
    throw new Error(`Invalid --window-mode "${windowModeRaw}", expected rolling or anchored`);
  }
  const seed = parseNumberFlag(flags.get('seed'), 'seed', { integer: true }) ?? 42;
  const bootstrapN =
    parseNumberFlag(flags.get('bootstrap-n'), 'bootstrap-n', { integer: true }) ??
    EXPOSURE_PROTOCOL.bootstrap.iterations;
  const timingDraws =
    parseNumberFlag(flags.get('timing-draws'), 'timing-draws', { integer: true }) ??
    EXPOSURE_PROTOCOL.timingShuffleDraws;
  const trials = parseNumberFlag(flags.get('trials'), 'trials', { integer: true }) ?? EXPOSURE_GRID_CELL_COUNT;
  const stressFeeMult =
    parseNumberFlag(flags.get('stress-fee-mult'), 'stress-fee-mult') ??
    EXPOSURE_PROTOCOL.stress.feeMultiplier;
  const stressSlippageMult =
    parseNumberFlag(flags.get('stress-slippage-mult'), 'stress-slippage-mult') ??
    EXPOSURE_PROTOCOL.stress.slippageMultiplier;
  const feeProfileRaw = flags.get('fee-profile') ?? DEFAULT_FEE_PROFILE;
  if (!isFeeProfileName(feeProfileRaw)) {
    throw new Error(`Unknown --fee-profile "${feeProfileRaw}", expected one of: ${FEE_PROFILE_NAMES.join(', ')}`);
  }

  // A stress run with no stress is not a configuration, it is a guaranteed
  // FAIL: the gate reports null and no run can reach it.
  if (stressFeeMult === 1 && stressSlippageMult === 1) {
    throw new Error(
      '--stress-fee-mult 1 with --stress-slippage-mult 1 leaves the stress gate unreachable; ' +
        'the gate compares a stressed expectancy against zero and would be reading the nominal series'
    );
  }

  const taskId =
    flags.get('task-id') ??
    (cellMode
      ? `exposure-cell-${Date.now()}`
      : defaultTaskId(factor ?? DEFAULT_FACTOR, interval ?? 'unknown', now));

  const out =
    flags.get('out') ??
    (cellMode
      ? `data/research/reports/exposure-cell-${taskId}.json`
      : `data/research/reports/exposure-${factor}-${interval}-${taskId}.json`);

  return {
    factor,
    interval,
    symbols: flags.has('symbols') ? parseList(flags.get('symbols')!) : undefined,
    start: parseIsoFlag(flags.get('start'), 'start'),
    end: parseIsoFlag(flags.get('end'), 'end'),
    datasetDir: flags.get('dataset-dir') ?? 'data/research',
    out,
    taskId,
    windows,
    trainFraction,
    windowMode: windowModeRaw,
    seed,
    bootstrapN,
    timingDraws,
    trials,
    stressFeeMult,
    stressSlippageMult,
    feeProfile: feeProfileRaw,
    allowLockbox: flags.get('allow-lockbox') === 'true',
    expectManifestHash: flags.get('expect-manifest-hash'),
    cell,
    reportPath,
  };
}

function resolveCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function inRange(t: number, start?: number, end?: number): boolean {
  if (start !== undefined && t < start) return false;
  if (end !== undefined && t > end) return false;
  return true;
}

interface LoadedSymbol {
  symbol: string;
  bars: ExposureSymbolInput;
  /** True when the symbol carried a recoverable funding rate on at least one bar. */
  fundingCovered: boolean;
  snapshotRows: number;
}

/**
 * Load one symbol's perp bars, funding and factor column, all on one grid.
 *
 * The column is derived here from the perp candles and the snapshot series
 * rather than through `buildResearchColumns`, which builds on spot candles by
 * construction. The rule is the same one `research-columns.ts` documents for
 * snapshot-derived columns: pinned to the latest snapshot at or before each
 * bar's OPEN, no shift, because a snapshot reading at or before the open is
 * already observable before the bar and needs no lag adjustment.
 */
function loadExposureSymbol(
  datasetDir: string,
  symbol: string,
  interval: string,
  factor: string,
  opts: { allowLockbox: boolean; start?: number; end?: number }
): LoadedSymbol | null {
  const perpResult = loadPerp(datasetDir, symbol, interval, 'klines', {
    allowLockbox: opts.allowLockbox,
  });
  const perpRows = perpResult.rows.filter((r) => inRange(r.t, opts.start, opts.end));
  if (perpRows.length === 0) return null;

  // This path holds the position on the perp, so the perp grid is the one that
  // counts. Assert the spot grid agrees wherever the spot file exists, so a
  // future dataset whose two series diverge fails here instead of silently
  // producing perp returns against a spot-derived factor. On the current
  // dataset every perp bar is a spot bar, so this is a guard against a
  // regression rather than an active constraint.
  const spotTimes = new Set(
    loadCandles(datasetDir, symbol, interval, { allowLockbox: opts.allowLockbox })
      .rows.filter((r) => inRange(r.t, opts.start, opts.end))
      .map((r) => r.t)
  );
  if (spotTimes.size > 0) {
    for (const row of perpRows) {
      if (!spotTimes.has(row.t)) {
        throw new Error(
          `${symbol} ${interval}: perp bar ${new Date(row.t).toISOString()} is not on the spot ` +
            'grid; the exposure path needs one shared bar grid'
        );
      }
    }
  }

  const candles: OHLCV[] = perpRows.map((r) => ({
    timestamp: r.t,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    volume: r.v,
  }));

  const snapshotResult = loadSnapshots(datasetDir, symbol, interval, {
    allowLockbox: opts.allowLockbox,
  });
  const snapshotRows = snapshotResult.rows;
  const snapshots = snapshotRows
    .filter((r) => opts.end === undefined || r.t <= opts.end)
    .map(toLeanSnapshot);

  const snapBars = buildSnapshotSeries(candles, snapshots, interval, { symbol });

  const fundingRates = candles.map((_, i) => {
    const rate = snapBars[i]?.futures?.fundingRate?.fundingRate;
    return typeof rate === 'number' && Number.isFinite(rate) ? rate : Number.NaN;
  });

  const rawPositioning = candles.map((_, i) => {
    const ratio = snapBars[i]?.futures?.longShortRatio?.longShortRatio;
    return typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : Number.NaN;
  });

  // Same estimator research-columns uses for this column, so the rule is one
  // rule: a trailing z over `bars` with a 30-sample floor.
  const windowBars = factorWindowBars(factor);
  const z = trailingZ(rawPositioning, windowBars, 30);

  return {
    symbol,
    fundingCovered: fundingRates.some((v) => Number.isFinite(v)),
    snapshotRows: snapshotRows.length,
    bars: {
      symbol,
      timestamps: candles.map((c) => c.timestamp),
      closes: candles.map((c) => c.close),
      fundingRates,
      z,
    },
  };
}

/** `positioningZ<N>` -> N. */
function factorWindowBars(factor: string): number {
  const match = /^positioningZ(\d+)$/.exec(factor);
  if (!match) throw new Error(`Unsupported --factor "${factor}" for the exposure path`);
  return Number(match[1]);
}

/** The same trailing z-score `factors.ts` exports, inlined here only because
 * the public one is typed over a Float64Array while these columns arrive as
 * plain arrays. Kept algorithmically identical on purpose. */
function trailingZ(series: readonly number[], windowBars: number, minSamples: number): number[] {
  const n = series.length;
  const out = new Array<number>(n).fill(Number.NaN);
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const entering = series[i];
    if (Number.isFinite(entering)) {
      count++;
      sum += entering;
      sumSq += entering * entering;
    }
    const leavingIndex = i - windowBars;
    if (leavingIndex >= 0) {
      const leaving = series[leavingIndex];
      if (Number.isFinite(leaving)) {
        count--;
        sum -= leaving;
        sumSq -= leaving * leaving;
      }
    }
    if (!Number.isFinite(series[i]) || count < minSamples) continue;
    const mean = sum / count;
    const variance = (sumSq - count * mean * mean) / (count - 1);
    const epsilon = 1e-12 * Math.max(sumSq / count, mean * mean, Number.MIN_VALUE);
    if (variance <= epsilon) continue;
    out[i] = (series[i] - mean) / Math.sqrt(variance);
  }
  return out;
}

export async function runExposureHarness(args: ExposureHarnessArgs): Promise<ExposureReport> {
  const startedAt = Date.now();
  if (!args.factor) throw new Error('--factor is required');
  if (!args.interval) throw new Error('--interval is required');

  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  if (args.expectManifestHash !== undefined && manifest.datasetHash !== args.expectManifestHash) {
    throw new Error(
      `Dataset manifest hash mismatch: loaded dataset has ${manifest.datasetHash}, ` +
        `expected ${args.expectManifestHash}`
    );
  }

  // The fallback resolution, recorded on the report's top-level costs: what a
  // symbol-scoped profile resolves to for a symbol it does not cover. Each
  // symbol's own per-unit-turnover cost is resolved again, per symbol, inside
  // simulateExposure via ExposureOptions.feeProfile below.
  const costs = studyCostConfig(args.interval, { profile: args.feeProfile });
  const costPerUnit = (costs.takerFeePercent ?? 0) + (costs.slippageBps ?? 0) / 10000;
  if (costPerUnit <= 0) {
    throw new Error(
      `Study cost for ${args.interval} is zero, so the stress multipliers cannot change ` +
        'anything and the stress gate would pass on identical numbers'
    );
  }

  const symbols = args.symbols && args.symbols.length > 0 ? args.symbols : manifest.symbols;
  const snapshotInterval = mapToSnapshotInterval(args.interval);

  const loaded: LoadedSymbol[] = [];
  for (const symbol of symbols) {
    const entry = loadExposureSymbol(args.datasetDir, symbol, args.interval, args.factor, {
      allowLockbox: args.allowLockbox,
      start: args.start,
      end: args.end,
    });
    if (entry === null) {
      console.error(`[exposure-harness] ${symbol}: no ${args.interval} perp bars, skipping`);
      continue;
    }
    loaded.push(entry);
    console.error(
      `[exposure-harness] ${args.interval} ${symbol}: ${entry.bars.timestamps.length} perp bars, ` +
        `${entry.snapshotRows} snapshot rows`
    );
  }
  if (loaded.length === 0) throw new Error(`No symbols produced ${args.interval} perp bars`);

  // Asymmetric funding is invisible in the report (ExposureReportSchema.costs
  // has no fundingEnabled field), so a run where some symbols pay and others do
  // not would be flattered with no trace. Refuse it.
  const uncovered = loaded.filter((l) => !l.fundingCovered).map((l) => l.symbol);
  if (uncovered.length > 0 && uncovered.length < loaded.length) {
    throw new Error(
      `Mixed snapshot coverage: ${uncovered.join(', ')} carry no ${snapshotInterval} funding ` +
        'reading while others do; pass --symbols to exclude them'
    );
  }

  // The factor column must start somewhere in the universe, and the run is
  // trimmed to the LAST of those starts: a bar where one symbol has no reading
  // is a bar the joint book cannot fully act on.
  // The perp series is not perfectly rectangular (SOLUSDT and XRPUSDT are each
  // missing two 2022 days), and the portfolio's held weights carry across a
  // bar, so the book runs on the timestamps every symbol shares.
  const aligned = alignToSharedGrid(loaded.map((l) => l.bars));
  if (aligned.droppedBars > 0) {
    console.error(
      `[exposure-harness] aligned to the shared grid: dropped ${aligned.droppedBars} bars ` +
        'that not every symbol carried'
    );
  }
  const alignedBySymbol = new Map(aligned.symbols.map((b) => [b.symbol, b]));
  const alignedLoaded = loaded.map((l) => ({
    ...l,
    bars: alignedBySymbol.get(l.symbol) as ExposureSymbolInput,
  }));

  const columns = new Map<string, readonly number[]>(
    alignedLoaded.map((l) => [l.symbol, l.bars.z])
  );
  const factorStart = jointFactorStart(columns);
  if (factorStart < 0) {
    throw new Error(`Factor "${args.factor}" never produced a finite reading for every symbol`);
  }

  // Trim past the LONGEST smoothing in the grid as well as the raw column's
  // own warmup: a trailing mean needs `smoothing` finite readings, so a run
  // trimmed to `factorStart` exactly would still be NaN for another
  // `max(smoothing) - 1` bars and every window head would sit out. See
  // exposure-walk-forward.ts's header.
  const trimStart = maxSmoothingWarmupBars(factorStart);
  const trimmed = alignedLoaded.map((l) => ({
    ...l,
    bars: sliceSymbolInput(l.bars, trimStart, l.bars.timestamps.length - 1),
  }));
  const usableBars = trimmed[0].bars.timestamps.length;
  console.error(
    `[exposure-harness] factor=${args.factor} rawWarmup=${factorStart} trim=${trimStart} ` +
      `usableBars=${usableBars} ` +
      `(${new Date(trimmed[0].bars.timestamps[0]).toISOString().slice(0, 10)} .. ` +
      `${new Date(trimmed[0].bars.timestamps[usableBars - 1]).toISOString().slice(0, 10)})`
  );

  const walk = runExposureWalkForward({
    symbols: trimmed.map((l) => l.bars),
    interval: args.interval,
    windows: {
      count: args.windows,
      trainFraction: args.trainFraction,
      mode: args.windowMode,
    },
    stress: {
      feeMultiplier: args.stressFeeMult,
      slippageMultiplier: args.stressSlippageMult,
    },
    feeProfile: args.feeProfile,
    onWindow: ({ index, total, ms }) =>
      console.error(`[exposure-harness] window ${index + 1}/${total} in ${ms} ms`),
  });

  const skipped = walk.windows.filter((w) => w.selectedParams === null);
  if (skipped.length > 0) {
    // Throwing rather than skipping is deliberate: a skipped window is not
    // representable in ExposureWindowSchema, and tolerating one would let
    // windowPositiveShare pass on a single surviving window.
    throw new Error(
      `No cell qualified in ${skipped.length} of ${walk.windows.length} windows:\n` +
        skipped.map((w) => `  window ${w.index}: ${w.skippedReason}`).join('\n')
    );
  }

  const universe = trimmed.map((l) => l.symbol);
  const selected = walk.windows.map((w) => w.oos as ExposureCellRun);
  const timingRandom = createSeededRandom(args.seed + TIMING_SEED_OFFSET);

  const nominal = poolExposureResults(selected, walk.allCells, universe, {
    interval: args.interval,
    seed: args.seed,
    trials: args.trials,
    bootstrapIterations: args.bootstrapN,
    timingDraws: args.timingDraws,
    benchmarkRandom: timingRandom,
  });

  // The stress number must come from a SEPARATE pool call whose `selected` is
  // the stressed cells. Passing them as the nominal `selected` would make every
  // headline statistic post-stress and the stress gate would be reading the
  // same series as expectancy, i.e. inert.
  const stressed = poolExposureResults(
    walk.windows.map((w) => w.oosStressed as ExposureCellRun),
    [],
    universe,
    {
      interval: args.interval,
      seed: args.seed,
      trials: args.trials,
      timingDraws: 0,
    }
  );
  const pooled = { ...nominal, stressMeanReturnPercent: stressed.stressMeanReturnPercent };

  const { gates, pass } = evaluateExposureGates(pooled, args.interval);

  const perSymbol: ExposurePerSymbolRow[] = universe.map((symbol) => {
    const contributions: number[] = [];
    for (const cell of selected) {
      const found = cell.result.perSymbol.find((s) => s.symbol === symbol);
      if (!found) continue;
      contributions.push(...found.returnContribution.filter((v) => Number.isFinite(v)));
    }
    const mean =
      contributions.length > 0
        ? contributions.reduce((a, b) => a + b, 0) / contributions.length
        : Number.NaN;
    return {
      symbol,
      bars: contributions.length,
      meanContributionPercent: Number.isFinite(mean) ? mean * 100 : null,
      positive: Number.isFinite(mean) && mean > 0,
    };
  });

  const windows: ExposureWindowRow[] = walk.windows.map((w) => {
    const result = w.oos!.result;
    const finite = result.netReturns.filter((v) => Number.isFinite(v));
    const mean = finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : Number.NaN;
    return {
      window: w.index,
      params: w.selectedParams as Record<string, number>,
      bars: result.bars,
      positive: finite.length > 0 && mean > 0,
      sharpe: finite.length > 1 ? toFiniteOrNull(perPeriodSharpe(finite)) : null,
      meanReturnPercent: Number.isFinite(mean) ? mean * 100 : null,
    };
  });

  const report: ExposureReport = {
    schemaVersion: 1,
    taskId: args.taskId,
    datasetManifestHash: manifest.datasetHash,
    lockboxApplied: !args.allowLockbox,
    factor: args.factor,
    interval: args.interval,
    symbols: universe,
    dateRange: { startMs: args.start ?? null, endMs: args.end ?? null },
    gridCells: EXPOSURE_GRID_CELL_COUNT,
    trials: pooled.trials,
    feeProfile: args.feeProfile,
    costs: {
      feePercent: costs.feePercent,
      slippageBps: costs.slippageBps ?? 0,
    },
    windowConfig: {
      mode: walk.windowConfig.mode,
      trainFraction: args.trainFraction,
      count: walk.windowConfig.count,
      minIsSharpeBars: walk.windowConfig.minIsSharpeBars,
    },
    stress: {
      feeMultiplier: args.stressFeeMult,
      slippageMultiplier: args.stressSlippageMult,
    },
    bootstrap: pooled.bootstrap,
    timing: { draws: pooled.timingDraws, blockLength: pooled.bootstrap.meanBlockLen },
    perSymbol,
    windows,
    pooled,
    gates,
    pass,
    computedAt: new Date().toISOString(),
    gitCommit: resolveCommit(),
    durationMs: Date.now() - startedAt,
  };

  const validated = validateExposureReport(report);
  if (!validated.ok) {
    throw new Error(
      `exposure-harness report failed schema validation:\n${validated.issues.join('\n')}`
    );
  }
  assertEveryPooledKeySurvived(pooled, validated.data.pooled);

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(validated.data, null, 2) + '\n', 'utf8');
  console.error(`[exposure-harness] wrote ${args.out}`);
  console.log(formatReport(validated.data));
  return validated.data;
}

function toFiniteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * Zod's plain `z.object` strips unknown keys silently, which already cost this
 * program once: `payoffRatio` was computed into `PooledStats` with no matching
 * schema entry and would have vanished on parse with no error. Assert that
 * every key of the pooled stats survived, so the next such omission fails
 * loudly instead.
 */
function assertEveryPooledKeySurvived(
  computed: Record<string, unknown>,
  parsed: Record<string, unknown>
): void {
  const missing = Object.keys(computed).filter((key) => !(key in parsed));
  if (missing.length > 0) {
    throw new Error(
      `ExposureReportSchema dropped ${missing.join(', ')} from pooled stats; ` +
        'add them to ExposurePooledStatsSchema rather than losing them silently'
    );
  }
}

export interface ExposureCellCheck {
  symbol: string;
  window: number;
  params: Record<string, number>;
  bars: number;
  sharpe: number | null;
  meanReturnPercent: number | null;
  symbolBars: number;
  symbolMeanContributionPercent: number | null;
}

/**
 * Re-run one window of a saved report and confirm it reproduces.
 *
 * The universe is JOINT, so this re-runs the whole portfolio restricted to one
 * window: `SYMBOL` selects what is reported, not what is simulated. A reader
 * arriving from the discrete path will assume otherwise, which is why the
 * module header and the printed line both carry the symbol.
 */
export async function runCell(args: ExposureHarnessArgs): Promise<ExposureCellCheck> {
  if (!args.cell) throw new Error('runCell requires args.cell');
  if (!args.reportPath) throw new Error('runCell requires --report <file>');

  const raw = JSON.parse(await readFile(args.reportPath, 'utf8'));
  const validated = validateExposureReport(raw);
  if (!validated.ok) {
    throw new Error(
      `--report ${args.reportPath} failed schema validation:\n${validated.issues.join('\n')}`
    );
  }
  const report = validated.data;

  if (args.factor !== undefined && args.factor !== report.factor) {
    throw new Error(`--factor "${args.factor}" disagrees with the report's factor "${report.factor}"`);
  }
  if (args.interval !== undefined && args.interval !== report.interval) {
    throw new Error(
      `--interval "${args.interval}" disagrees with the report's interval "${report.interval}"`
    );
  }
  if (args.symbols !== undefined) {
    const same =
      args.symbols.length === report.symbols.length &&
      args.symbols.every((s, i) => s === report.symbols[i]);
    if (!same) {
      throw new Error(
        '--symbols differs from the report\'s universe; a different universe changes `gross` ' +
          'and therefore every number, so it is not a spot check'
      );
    }
  }
  if (!report.symbols.includes(args.cell.symbol)) {
    throw new Error(`Symbol "${args.cell.symbol}" not present in report ${args.reportPath}`);
  }
  if (args.cell.window < 0 || args.cell.window >= report.windows.length) {
    throw new Error(
      `Window ${args.cell.window} not present in report ${args.reportPath} ` +
        `(it has ${report.windows.length})`
    );
  }

  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) {
    throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  }
  const manifest = loadManifest(args.datasetDir);
  const expectHash = args.expectManifestHash ?? report.datasetManifestHash;
  if (manifest.datasetHash !== expectHash) {
    throw new Error(
      `Dataset manifest hash mismatch: loaded dataset has ${manifest.datasetHash}, expected ${expectHash}`
    );
  }

  // --start / --end are IGNORED in favour of the report's own range: silently
  // checking a different range is not a spot check.
  const start = report.dateRange.startMs ?? undefined;
  const end = report.dateRange.endMs ?? undefined;
  const allowLockbox = !report.lockboxApplied;

  const loaded: LoadedSymbol[] = [];
  for (const symbol of report.symbols) {
    const entry = loadExposureSymbol(args.datasetDir, symbol, report.interval, report.factor, {
      allowLockbox,
      start,
      end,
    });
    if (entry) loaded.push(entry);
  }
  // The SAME two steps the full run applies: align to the shared grid, then
  // trim past the smoothing warmup. Skipping either would put the spot check on
  // a different series than the report it is checking.
  const aligned = alignToSharedGrid(loaded.map((l) => l.bars));
  const alignedBySymbol = new Map(aligned.symbols.map((b) => [b.symbol, b]));
  const alignedLoaded = loaded.map((l) => ({
    ...l,
    bars: alignedBySymbol.get(l.symbol) as ExposureSymbolInput,
  }));
  const columns = new Map<string, readonly number[]>(
    alignedLoaded.map((l) => [l.symbol, l.bars.z])
  );
  const factorStart = jointFactorStart(columns);
  const trimStart = maxSmoothingWarmupBars(factorStart);
  const trimmed = alignedLoaded.map((l) => ({
    ...l,
    bars: sliceSymbolInput(l.bars, trimStart, l.bars.timestamps.length - 1),
  }));

  const window = args.cell.window;
  // The report's OWN profile, not --fee-profile: a spot check reproduces the
  // run the report describes, not whatever the CLI invocation's own flags
  // happen to say. report.feeProfile is optional (reports written before
  // 2026-09-26 have none), hence the DEFAULT_FEE_PROFILE fallback; validated
  // by isFeeProfileName the same way parseArgs validates the CLI flag.
  if (report.feeProfile !== undefined && !isFeeProfileName(report.feeProfile)) {
    throw new Error(`Report names unknown fee profile "${report.feeProfile}"`);
  }
  const feeProfile = (report.feeProfile ?? DEFAULT_FEE_PROFILE) as FeeProfileName;
  const walk = runExposureWalkForward({
    symbols: trimmed.map((l) => l.bars),
    interval: report.interval,
    windows: {
      count: report.windowConfig.count,
      trainFraction: report.windowConfig.trainFraction,
      mode: report.windowConfig.mode,
    },
    stress: report.stress,
    feeProfile,
  });

  const replayed = walk.windows[window];
  const expected = report.windows[window];
  if (replayed.selectedParams === null) {
    throw new Error(`Window ${window} re-derived no qualifying cell: ${replayed.skippedReason}`);
  }
  for (const key of Object.keys(expected.params)) {
    if (replayed.selectedParams[key] !== expected.params[key]) {
      throw new Error(
        `Window ${window} selected ${JSON.stringify(replayed.selectedParams)} but the report ` +
          `records ${JSON.stringify(expected.params)}`
      );
    }
  }

  const result = replayed.oos!.result;
  const finite = result.netReturns.filter((v) => Number.isFinite(v));
  const mean = finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : Number.NaN;
  const sharpe = finite.length > 1 ? toFiniteOrNull(perPeriodSharpe(finite)) : null;
  const meanReturnPercent = Number.isFinite(mean) ? mean * 100 : null;

  if (result.bars !== expected.bars) {
    throw new Error(`Window ${window} re-derived ${result.bars} bars, report records ${expected.bars}`);
  }
  if (!nearlyEqual(sharpe, expected.sharpe)) {
    throw new Error(`Window ${window} re-derived sharpe ${sharpe}, report records ${expected.sharpe}`);
  }
  if (!nearlyEqual(meanReturnPercent, expected.meanReturnPercent)) {
    throw new Error(
      `Window ${window} re-derived meanReturnPercent ${meanReturnPercent}, ` +
        `report records ${expected.meanReturnPercent}`
    );
  }

  const found = result.perSymbol.find((s) => s.symbol === args.cell!.symbol);
  const symbolContributions = found
    ? found.returnContribution.filter((v) => Number.isFinite(v))
    : [];
  const symbolMean =
    symbolContributions.length > 0
      ? symbolContributions.reduce((a, b) => a + b, 0) / symbolContributions.length
      : Number.NaN;

  const check: ExposureCellCheck = {
    symbol: args.cell.symbol,
    window,
    params: replayed.selectedParams,
    bars: result.bars,
    sharpe,
    meanReturnPercent,
    symbolBars: symbolContributions.length,
    symbolMeanContributionPercent: Number.isFinite(symbolMean) ? symbolMean * 100 : null,
  };
  console.log(JSON.stringify(check));
  return check;
}

function nearlyEqual(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= 1e-9;
}

function fmt(value: number | null, digits = 4): string {
  return value === null ? 'n/a' : value.toFixed(digits);
}

function formatReport(report: ExposureReport): string {
  const lines: string[] = [];
  lines.push(
    `exposure ${report.factor} ${report.interval} symbols=${report.symbols.length} ` +
      `windows=${report.windowConfig.count} trials=${report.trials} ` +
      `dataset=${report.datasetManifestHash.slice(0, 12)}`
  );
  lines.push(
    `  barsHeld=${report.pooled.barsHeld}/${report.pooled.barsTotal} ` +
      `(share ${report.pooled.exposureShare.toFixed(3)}) ` +
      `mean=${fmt(report.pooled.meanReturnPercent)}% ` +
      `sharpe=${fmt(report.pooled.sharpe)} ` +
      `ci=[${fmt(report.pooled.sharpeCi95?.[0] ?? null)}, ${fmt(report.pooled.sharpeCi95?.[1] ?? null)}] ` +
      `blockLen=${report.pooled.bootstrap.meanBlockLen}`
  );
  lines.push(
    `  turnover=${report.pooled.totalTurnover.toFixed(2)} ` +
      `barsBetweenRebalances=${fmt(report.pooled.meanBarsBetweenRebalances, 1)} ` +
      `maxDrawdown=${fmt(report.pooled.maxDrawdownPercent, 2)}% ` +
      `timingP=${fmt(report.pooled.timingP)} ` +
      `stressMean=${fmt(report.pooled.stressMeanReturnPercent)}%`
  );
  for (const gate of report.gates) {
    lines.push(`  ${gate.pass ? 'PASS' : 'FAIL'} ${gate.name.padEnd(10)} ${fmt(gate.value)}`);
  }
  lines.push(`  ${report.pass ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cell !== undefined) {
    await runCell(args);
  } else {
    await runExposureHarness(args);
  }
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

/** Exported for the tests, which drive the pure helpers directly. */
export const __testing = {
  parseArgs,
  preSmooth,
  trailingZ,
  factorWindowBars,
  simulateExposure,
};
