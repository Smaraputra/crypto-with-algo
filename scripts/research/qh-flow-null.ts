/**
 * QH-FLOW circular-shift null and hold-out detection floor.
 *
 * Implements the "Shuffled-label null beside every real run" line of the
 * LOCKED MEASUREMENT section in qh-flow.ts as tightened by AMENDMENT 1
 * (A1-1): 200 draws, seed 7, offsets of at least 30 days, but ONE offset per
 * draw shared by every symbol (an independent offset per symbol destroys the
 * cross-symbol correlation the pooled t ignores, and understates the null's
 * spread), applied on the COMMON BAR GRID, the intersection of the symbols'
 * bar timestamps in the window after the matrix warmup. A value at grid
 * position i moves to grid position (i + k) mod G; forward returns stay in
 * place. Bars not on the grid are excluded from the null's pooled statistic,
 * and the report says how many bars each symbol loses to the intersection.
 * The null's standard deviation of pooled IC times 3.15 is the detection
 * floor of the cell.
 *
 * Defaults are the locked measurement: execution lag 1, perp returns, horizons
 * 1,4,8,12 at 1h and 1,2,3 at 4h (any other interval needs --horizons), and
 * NULL-ONLY. Observed statistics are produced only with
 * `--with-observed --floor-report <path>`, where the floor report must be a
 * null-only report of this CLI for the same dataset hash, interval, window,
 * lag, return series, horizons, factors, draws, seed and minimum shift, so the
 * floor is on record before any observed cell is read.
 *
 * Implementation notes (choices the locked text leaves open):
 * - Offsets are integers drawn uniformly from [minShiftBars, G - minShiftBars],
 *   G being the grid length.
 * - nullSdIc is the sample standard deviation (n - 1) across valid draws.
 *   nullP95AbsT is the nearest-rank 95th percentile of |t| across valid draws.
 * - empiricalP = (1 + #{valid draws with |t_null| >= |t_obs|}) / (1 + #valid
 *   draws), M3; validDraws is reported per cell. A draw factor-ic would drop
 *   is not valid.
 * - observedIc/observedT are factor-ic's own, on every bar of every symbol (the
 *   self-check in the tests reproduces them exactly), reported as such. The null
 *   is on the grid, so empiricalP uses observedGridT, the unshifted statistic
 *   on the same grid (like with like); observedGridIc/observedGridT are its basis.
 * - A cell with fewer than 2 valid draws is emitted with NaN statistics and a
 *   reason; an observed cell factor-ic would drop gets null observed fields and
 *   a reason, logged to stderr.
 * - The pooled statistic is factor-ic's own: buildFactorIcReport and this null
 *   both call pooledHorizonStat (factor-ic.ts), so --execution-lag,
 *   --return-series and every MIN_PAIRS / non-finite drop rule are shared.
 * - Lockbox: by default the loaders truncate at 2026-07-01 and assertBeforeLockbox
 *   refuses any loaded bar at or after the lockbox start. The opt-in --allow-lockbox
 *   (forward test, forward-test.ts only; default off) passes allowLockbox to the loaders
 *   and skips assertBeforeLockbox.
 * - empiricalPLow / empiricalPHigh (forward test) are the one-sided empirical p of the
 *   observed grid IC against the null IC draws: (1 + #draws <= obs) / (1 + valid) and
 *   (1 + #draws >= obs) / (1 + valid). They are reported with observed fields only.
 */

import { readFileSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { intervalToMs } from '@/lib/intervals';
import { appendCrossSymbolFactors, CROSS_SYMBOL_NAMES } from './cross-symbol-factors';
import { LOCKBOX_START } from './dataset-format';
import {
  DEFAULT_MIN_CROSS_SECTION,
  loadSymbolData,
  mulberry32,
  pooledHorizonStat,
  symbolForwardReturns,
  type SymbolData,
} from './factor-ic';
import { loadManifest, verifyManifest } from './load-dataset';
import { execFileSync } from 'child_process';

export const NULL_DRAWS = 200;
export const NULL_SEED = 7;
export const NULL_MIN_SHIFT_DAYS = 30;
/** Locked multiplier of the null's sd of pooled IC (the survivor rule's |t| bar). */
export const DETECTION_FLOOR_MULTIPLIER = 3.15;

/** Locked horizons per interval (qh-flow.ts MEASUREMENT). */
export const QH_FLOW_HORIZONS: Readonly<Record<string, readonly number[]>> = {
  '1h': [1, 4, 8, 12],
  '4h': [1, 2, 3],
};

export const NULL_REPORT_KIND = 'qh-flow-null';

export const QH_FLOW_FACTORS = ['raw.qhOpenImb', 'raw.fiveMinOpenImb', 'raw.largeTakerImb', 'raw.smallTakerImb'];

export interface NullArgs {
  interval: string;
  datasetDir: string;
  start?: number;
  end?: number;
  horizons: number[];
  factors: string[];
  executionLagBars: number;
  returnSeries: 'spot' | 'perp';
  draws: number;
  seed: number;
  minShiftDays: number;
  /** True unless --with-observed. */
  nullOnly: boolean;
  /** Present (true) only with --allow-lockbox. */
  allowLockbox?: boolean;
  floorReport?: string;
  out: string;
}

export interface NullCell {
  factor: string;
  horizon: number;
  nullMeanIc: number;
  nullSdIc: number;
  nullP95AbsT: number;
  detectionFloorIc: number;
  /** Draws that produced a statistic factor-ic would keep. */
  validDraws: number;
  observedIc?: number | null;
  observedT?: number | null;
  /** Unshifted statistic on the common grid: the basis of empiricalP. */
  observedGridIc?: number | null;
  observedGridT?: number | null;
  empiricalP?: number | null;
  /** One-sided empirical p of the grid IC: (1 + #null draws with IC <= observed) / (validDraws + 1). */
  empiricalPLow?: number | null;
  /** Same with >=. */
  empiricalPHigh?: number | null;
  /** Present only when the cell could not be fully computed. */
  reason?: string;
}

export interface NullGrid {
  bars: number;
  firstT: number;
  lastT: number;
  perSymbol: Array<{ symbol: string; barsAfterWarmup: number; dropped: number }>;
}

export interface NullReport {
  reportKind: typeof NULL_REPORT_KIND;
  args: NullArgs;
  datasetManifestHash: string;
  commit: string;
  symbols: string[];
  barCounts: number[];
  grid: NullGrid;
  minShiftBars: number;
  /** One offset per draw, shared by every symbol. */
  offsets: number[];
  floorReport?: { path: string; datasetManifestHash: string };
  cells: NullCell[];
}

const BOOLEAN_FLAGS = new Set(['null-only', 'with-observed', 'allow-lockbox']);
const VALUE_FLAGS = new Set([
  'interval', 'dataset-dir', 'start', 'end', 'horizons', 'factors', 'execution-lag',
  'return-series', 'draws', 'seed', 'min-shift-days', 'out', 'floor-report',
]);

function parseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseIso(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Invalid --${name} date: ${value}`);
  return ms;
}

function parseInteger(value: string | undefined, name: string, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`--${name} must be an integer of at least ${min}, got "${value}"`);
  }
  return n;
}

function defaultHorizons(interval: string): number[] {
  const locked = QH_FLOW_HORIZONS[interval];
  if (!locked) {
    throw new Error(`No locked horizons for interval ${interval}; pass --horizons explicitly`);
  }
  return [...locked];
}

export function parseNullArgs(argv: string[]): NullArgs {
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
    if (!VALUE_FLAGS.has(key)) throw new Error(`Unknown flag --${key}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    flags.set(key, value);
    i++;
  }
  const interval = flags.get('interval');
  if (!interval) throw new Error('--interval is required');

  if (booleans.has('null-only') && booleans.has('with-observed')) {
    throw new Error('--null-only and --with-observed contradict each other');
  }
  const withObserved = booleans.has('with-observed');
  if (withObserved && !flags.has('floor-report')) {
    throw new Error('--with-observed needs --floor-report <path> (a null-only report of this CLI)');
  }
  if (!withObserved && flags.has('floor-report')) {
    throw new Error('--floor-report only applies with --with-observed');
  }

  const lagRaw = flags.get('execution-lag');
  if (lagRaw !== undefined && !/^\d+$/.test(lagRaw)) {
    throw new Error(`--execution-lag must be a non-negative integer, got "${lagRaw}"`);
  }
  const rs = flags.get('return-series');
  if (rs !== undefined && rs !== 'spot' && rs !== 'perp') {
    throw new Error(`--return-series must be spot or perp, got "${rs}"`);
  }
  const horizons = flags.has('horizons')
    ? parseList(flags.get('horizons')!).map((s) => {
        const n = Number(s);
        if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid horizon in --horizons: "${s}"`);
        return n;
      })
    : defaultHorizons(interval);
  const minShiftRaw = flags.get('min-shift-days');
  const minShiftDays = minShiftRaw === undefined ? NULL_MIN_SHIFT_DAYS : Number(minShiftRaw);
  if (!Number.isFinite(minShiftDays) || minShiftDays <= 0) {
    throw new Error(`--min-shift-days must be positive, got "${minShiftRaw}"`);
  }

  return {
    interval,
    datasetDir: flags.get('dataset-dir') ?? 'data/research',
    start: parseIso(flags.get('start'), 'start'),
    end: parseIso(flags.get('end'), 'end'),
    horizons,
    factors: flags.has('factors') ? parseList(flags.get('factors')!) : [...QH_FLOW_FACTORS],
    executionLagBars: lagRaw === undefined ? 1 : Number(lagRaw),
    returnSeries: rs === 'spot' ? 'spot' : 'perp',
    draws: parseInteger(flags.get('draws'), 'draws', NULL_DRAWS, 1),
    seed: parseInteger(flags.get('seed'), 'seed', NULL_SEED, 0),
    minShiftDays,
    nullOnly: !withObserved,
    ...(booleans.has('allow-lockbox') ? { allowLockbox: true } : {}),
    ...(withObserved ? { floorReport: flags.get('floor-report') } : {}),
    out: flags.get('out') ?? `data/research/reports/qh-flow-null-${interval}.json`,
  };
}

export function minShiftBarsOf(minShiftDays: number, interval: string): number {
  return Math.ceil((minShiftDays * 86_400_000) / intervalToMs(interval));
}

/**
 * One offset per draw, shared by every symbol (AMENDMENT 1, A1-1), from one
 * mulberry32 stream. Each is an integer uniform on [minShiftBars, G - minShiftBars].
 */
export function drawOffsets(seed: number, draws: number, gridLength: number, minShiftBars: number): number[] {
  if (gridLength < 2 * minShiftBars) {
    throw new Error(`Common grid of ${gridLength} bars is too short for a minimum shift of ${minShiftBars} bars`);
  }
  const rng = mulberry32(seed);
  const out: number[] = [];
  for (let d = 0; d < draws; d++) {
    out.push(minShiftBars + Math.floor(rng() * (gridLength - 2 * minShiftBars + 1)));
  }
  return out;
}

/**
 * The common bar grid: timestamps present in every symbol after that symbol's
 * matrix warmup, ascending, with each symbol's matrix index of every grid
 * timestamp.
 */
export function commonGrid(
  symbols: Array<{ symbol: string; timestamps: ArrayLike<number>; warmupBars: number }>
): { timestamps: number[]; indices: number[][]; grid: NullGrid } {
  const perSymbol = symbols.map((s) => {
    const byT = new Map<number, number>();
    for (let i = s.warmupBars; i < s.timestamps.length; i++) byT.set(s.timestamps[i], i);
    return byT;
  });
  const first = perSymbol[0] ?? new Map<number, number>();
  const timestamps = [...first.keys()].filter((t) => perSymbol.every((m) => m.has(t))).sort((a, b) => a - b);
  const indices = perSymbol.map((m) => timestamps.map((t) => m.get(t)!));
  return {
    timestamps,
    indices,
    grid: {
      bars: timestamps.length,
      firstT: timestamps[0] ?? 0,
      lastT: timestamps[timestamps.length - 1] ?? 0,
      perSymbol: symbols.map((s, i) => ({
        symbol: s.symbol,
        barsAfterWarmup: perSymbol[i].size,
        dropped: perSymbol[i].size - timestamps.length,
      })),
    },
  };
}

/** Throws when any loaded bar sits at or after the lockbox start. */
export function assertBeforeLockbox(timestamps: ArrayLike<number>): void {
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] >= LOCKBOX_START) {
      throw new Error(
        `Refusing to run: bar ${new Date(timestamps[i]).toISOString()} is at or after the lockbox start ${new Date(LOCKBOX_START).toISOString()}`
      );
    }
  }
}

function shiftColumn(col: ArrayLike<number>, k: number): number[] {
  const n = col.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = col[(i + k) % n];
  return out;
}

/** (1 + #draws at or beyond the observed IC in the given tail) / (1 + draws). NaN when there are no draws. */
export function empiricalIcP(draws: ArrayLike<number>, observed: number, tail: 'low' | 'high'): number {
  if (draws.length === 0) return NaN;
  let hits = 0;
  for (let i = 0; i < draws.length; i++) {
    if (tail === 'low' ? draws[i] <= observed : draws[i] >= observed) hits++;
  }
  return (1 + hits) / (draws.length + 1);
}

function resolveCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function percentileNearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** Throws unless `path` is a null-only report of this CLI that matches the run it is a floor for. */
export function assertFloorReportMatches(
  path: string,
  args: NullArgs,
  manifestHash: string
): { path: string; datasetManifestHash: string } {
  let floor: NullReport;
  try {
    floor = JSON.parse(readFileSync(path, 'utf8')) as NullReport;
  } catch (err) {
    throw new Error(`--floor-report ${path} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const fail = (what: string): never => {
    throw new Error(`--floor-report ${path} does not match this run: ${what}`);
  };
  if (floor?.reportKind !== NULL_REPORT_KIND) fail(`not a ${NULL_REPORT_KIND} report`);
  if (floor.args?.nullOnly !== true) fail('it is not a null-only report');
  if (floor.datasetManifestHash !== manifestHash) {
    fail(`dataset manifest hash ${floor.datasetManifestHash} vs ${manifestHash}`);
  }
  const f = floor.args;
  if (f.interval !== args.interval) fail(`interval ${f.interval} vs ${args.interval}`);
  if (f.start !== args.start || f.end !== args.end) fail('window differs');
  if (f.executionLagBars !== args.executionLagBars) fail('execution lag differs');
  if (f.returnSeries !== args.returnSeries) fail('return series differs');
  if (JSON.stringify(f.horizons) !== JSON.stringify(args.horizons)) fail('horizons differ');
  if (JSON.stringify([...f.factors].sort()) !== JSON.stringify([...args.factors].sort())) fail('factors differ');
  if (f.draws !== args.draws || f.seed !== args.seed || f.minShiftDays !== args.minShiftDays) {
    fail('draws, seed or minimum shift differ');
  }
  return { path, datasetManifestHash: floor.datasetManifestHash };
}

export async function buildNullReport(args: NullArgs): Promise<NullReport> {
  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  const manifest = loadManifest(args.datasetDir);
  const symbols = manifest.symbols;
  const floorReport = args.nullOnly
    ? undefined
    : assertFloorReportMatches(args.floorReport ?? '', args, manifest.datasetHash);

  const data: SymbolData[] = symbols.map((symbol) =>
    loadSymbolData(args.datasetDir, symbol, args.interval, {
      allowLockbox: args.allowLockbox === true,
      start: args.start,
      end: args.end,
    })
  );
  if (args.allowLockbox === true) {
    console.error('[qh-flow-null] --allow-lockbox: lockbox rows are read (forward test)');
  } else {
    for (const d of data) assertBeforeLockbox(d.matrix.timestamps);
  }
  if (args.factors.some((f) => (CROSS_SYMBOL_NAMES as readonly string[]).includes(f))) {
    appendCrossSymbolFactors(data, DEFAULT_MIN_CROSS_SECTION);
  }
  if (args.returnSeries === 'perp') {
    for (const d of data) {
      if (!d.matrix.perpCloses.some((c) => Number.isFinite(c))) {
        throw new Error(`--return-series perp: no perpetual bars for ${d.symbol} ${args.interval} in this dataset`);
      }
    }
  }

  const known = new Set(data.flatMap((d) => d.matrix.names));
  const missing = args.factors.filter((f) => !known.has(f));
  if (missing.length > 0) throw new Error(`Unknown factor(s) requested: ${missing.join(', ')}`);

  const barCounts = data.map((d) => d.matrix.timestamps.length);
  const common = commonGrid(
    data.map((d) => ({ symbol: d.symbol, timestamps: d.matrix.timestamps, warmupBars: d.matrix.warmupBars }))
  );
  const gridLength = common.timestamps.length;
  for (const p of common.grid.perSymbol) {
    if (p.dropped > 0) {
      console.error(`[qh-flow-null] ${p.symbol}: ${p.dropped} of ${p.barsAfterWarmup} bars are off the common grid`);
    }
  }
  const minShiftBars = minShiftBarsOf(args.minShiftDays, args.interval);
  const offsets = drawOffsets(args.seed, args.draws, gridLength, minShiftBars);

  // Forward returns are computed on each symbol's own full series, then read at the grid bars.
  const pick = (arr: ArrayLike<number>, idx: number[]): Float64Array => Float64Array.from(idx, (i) => arr[i]);
  const fullFwd = new Map<number, Float64Array[]>();
  const gridFwd = new Map<number, Float64Array[]>();
  for (const h of args.horizons) {
    const full = data.map((d) => symbolForwardReturns(d, h, args.executionLagBars, args.returnSeries));
    fullFwd.set(h, full);
    gridFwd.set(h, full.map((f, s) => pick(f, common.indices[s])));
  }

  const cells: NullCell[] = [];
  for (const factor of args.factors) {
    const columns: Array<ArrayLike<number> | null> = data.map((d) => {
      const idx = d.matrix.names.indexOf(factor);
      return idx === -1 ? null : d.matrix.values[idx];
    });
    const gridColumns = columns.map((col, s) => (col ? pick(col, common.indices[s]) : null));

    const nullIc = new Map<number, number[]>();
    const nullAbsT = new Map<number, number[]>();
    for (const h of args.horizons) {
      nullIc.set(h, []);
      nullAbsT.set(h, []);
    }
    for (let d = 0; d < args.draws; d++) {
      const shifted = gridColumns.map((col) => (col ? shiftColumn(col, offsets[d]) : null));
      for (const h of args.horizons) {
        const stat = pooledHorizonStat(shifted, gridFwd.get(h)!, h);
        if (stat) {
          nullIc.get(h)!.push(stat.ic);
          nullAbsT.get(h)!.push(Math.abs(stat.icT));
        }
      }
    }

    for (const h of args.horizons) {
      const ics = nullIc.get(h)!;
      const absT = nullAbsT.get(h)!.slice().sort((a, b) => a - b);
      let cell: NullCell;
      if (ics.length < 2) {
        const reason = `only ${ics.length} of ${args.draws} draws produced a statistic factor-ic would keep`;
        console.error(`[qh-flow-null] ${factor} h=${h}: ${reason}`);
        cell = {
          factor,
          horizon: h,
          nullMeanIc: NaN,
          nullSdIc: NaN,
          nullP95AbsT: NaN,
          detectionFloorIc: NaN,
          validDraws: ics.length,
          reason,
        };
      } else {
        const mean = ics.reduce((sum, v) => sum + v, 0) / ics.length;
        const sd = Math.sqrt(ics.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (ics.length - 1));
        cell = {
          factor,
          horizon: h,
          nullMeanIc: mean,
          nullSdIc: sd,
          nullP95AbsT: percentileNearestRank(absT, 0.95),
          detectionFloorIc: DETECTION_FLOOR_MULTIPLIER * sd,
          validDraws: ics.length,
        };
      }
      if (!args.nullOnly) {
        const obs = pooledHorizonStat(columns, fullFwd.get(h)!, h);
        const obsGrid = pooledHorizonStat(gridColumns, gridFwd.get(h)!, h);
        cell.observedGridIc = obsGrid ? obsGrid.ic : null;
        cell.observedGridT = obsGrid ? obsGrid.icT : null;
        cell.empiricalPLow = obsGrid ? empiricalIcP(ics, obsGrid.ic, 'low') : null;
        cell.empiricalPHigh = obsGrid ? empiricalIcP(ics, obsGrid.ic, 'high') : null;
        if (obs) {
          cell.observedIc = obs.ic;
          cell.observedT = obs.icT;
          // Like with like: the grid observed t against the grid null draws.
          cell.empiricalP =
            absT.length === 0 || !obsGrid
              ? null
              : (1 + absT.filter((v) => v >= Math.abs(obsGrid.icT)).length) / (1 + absT.length);
        } else {
          const reason = 'observed cell has no statistic factor-ic would keep';
          console.error(`[qh-flow-null] ${factor} h=${h}: ${reason}`);
          cell.observedIc = null;
          cell.observedT = null;
          cell.empiricalP = null;
          cell.empiricalPLow = null;
          cell.empiricalPHigh = null;
          cell.reason = cell.reason ? `${cell.reason}; ${reason}` : reason;
        }
      }
      cells.push(cell);
    }
  }

  return {
    reportKind: NULL_REPORT_KIND,
    args,
    datasetManifestHash: manifest.datasetHash,
    commit: resolveCommit(),
    symbols,
    barCounts,
    grid: common.grid,
    minShiftBars,
    offsets,
    ...(floorReport ? { floorReport } : {}),
    cells,
  };
}

async function main(): Promise<void> {
  const args = parseNullArgs(process.argv.slice(2));
  const report = await buildNullReport(args);
  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, JSON.stringify(report, null, 2));
  for (const c of report.cells) {
    console.error(
      `[qh-flow-null] ${c.factor} h=${c.horizon} sd=${c.nullSdIc.toFixed(5)} floor=${c.detectionFloorIc.toFixed(5)} p95|t|=${c.nullP95AbsT.toFixed(2)}` +
        ` valid=${c.validDraws}` +
        (c.empiricalP == null ? '' : ` obsIc=${c.observedIc!.toFixed(5)} obsT=${c.observedT!.toFixed(2)} p=${c.empiricalP.toFixed(4)}`)
    );
  }
  console.error(`[qh-flow-null] wrote ${args.out}`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
