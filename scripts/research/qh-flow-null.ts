/**
 * QH-FLOW circular-shift null and hold-out detection floor.
 *
 * Implements the "Shuffled-label null beside every real run" line of the
 * LOCKED MEASUREMENT section in qh-flow.ts literally: 200 draws, seed 7; each
 * draw circularly shifts every symbol's factor column by an independent
 * uniform offset of at least 30 days (the column's autocorrelation survives,
 * its alignment with forward returns does not), recomputes the pooled IC and
 * t of every cell, and reports the null's 95th percentile |t| and the
 * observed cell's empirical p. The null's standard deviation of pooled IC
 * times 3.15 is the hold-out detection floor.
 *
 * Implementation notes (choices the locked text leaves open):
 * - One offset per symbol per draw, shared by every factor column of that
 *   symbol, so the cross-factor structure inside a symbol is preserved.
 * - Offsets are integers drawn uniformly from [minShiftBars, n - minShiftBars],
 *   n being the symbol's bar count in the window. A shifted column is
 *   shifted[i] = column[(i + k) mod n]; forward returns stay in place.
 * - nullSdIc is the sample standard deviation (n - 1) across draws.
 *   nullP95AbsT is the nearest-rank 95th percentile of |t| across draws.
 * - A draw factor-ic would drop never counts as exceeding the observed |t|.
 * - A cell with fewer than 2 valid draws is emitted with NaN statistics and a
 *   reason; an observed cell factor-ic would drop gets null observed fields and
 *   a reason, logged to stderr.
 * - The pooled statistic is factor-ic's own: buildFactorIcReport and this null
 *   both call pooledHorizonStat (factor-ic.ts), so --execution-lag,
 *   --return-series and every MIN_PAIRS / non-finite drop rule are shared. A
 *   draw factor-ic would drop (null stat) is not counted.
 * - Lockbox: the loaders always truncate at 2026-07-01 and --allow-lockbox is
 *   not accepted; assertBeforeLockbox additionally refuses any loaded bar at
 *   or after the lockbox start.
 */

import { mkdir, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { intervalToMs } from '@/lib/intervals';
import { appendCrossSymbolFactors, CROSS_SYMBOL_NAMES } from './cross-symbol-factors';
import { LOCKBOX_START } from './dataset-format';
import {
  DEFAULT_HORIZONS,
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

const QH_FLOW_FACTORS = ['raw.qhOpenImb', 'raw.fiveMinOpenImb', 'raw.largeTakerImb', 'raw.smallTakerImb'];

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
  nullOnly: boolean;
  out: string;
}

export interface NullCell {
  factor: string;
  horizon: number;
  nullMeanIc: number;
  nullSdIc: number;
  nullP95AbsT: number;
  detectionFloorIc: number;
  observedIc?: number | null;
  observedT?: number | null;
  empiricalP?: number | null;
  /** Present only when the cell could not be fully computed. */
  reason?: string;
}

export interface NullReport {
  args: NullArgs;
  datasetManifestHash: string;
  commit: string;
  symbols: string[];
  barCounts: number[];
  minShiftBars: number;
  offsets: number[][];
  cells: NullCell[];
}

const BOOLEAN_FLAGS = new Set(['null-only']);
const VALUE_FLAGS = new Set([
  'interval', 'dataset-dir', 'start', 'end', 'horizons', 'factors', 'execution-lag',
  'return-series', 'draws', 'seed', 'min-shift-days', 'out',
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
    : [...DEFAULT_HORIZONS];
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
    executionLagBars: lagRaw === undefined ? 0 : Number(lagRaw),
    returnSeries: rs === 'perp' ? 'perp' : 'spot',
    draws: parseInteger(flags.get('draws'), 'draws', NULL_DRAWS, 1),
    seed: parseInteger(flags.get('seed'), 'seed', NULL_SEED, 0),
    minShiftDays,
    nullOnly: booleans.has('null-only'),
    out: flags.get('out') ?? `data/research/reports/qh-flow-null-${interval}.json`,
  };
}

export function minShiftBarsOf(minShiftDays: number, interval: string): number {
  return Math.ceil((minShiftDays * 86_400_000) / intervalToMs(interval));
}

/**
 * Offsets for every draw and symbol, from one mulberry32 stream: draw-major,
 * symbol order within a draw, one stream value per symbol. Each is an integer
 * uniform on [minShiftBars, n - minShiftBars].
 */
export function drawOffsets(seed: number, draws: number, lengths: number[], minShiftBars: number): number[][] {
  for (const n of lengths) {
    if (n < 2 * minShiftBars) {
      throw new Error(`Symbol with ${n} bars is too short for a minimum shift of ${minShiftBars} bars`);
    }
  }
  const rng = mulberry32(seed);
  const out: number[][] = [];
  for (let d = 0; d < draws; d++) {
    out.push(lengths.map((n) => minShiftBars + Math.floor(rng() * (n - 2 * minShiftBars + 1))));
  }
  return out;
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

export async function buildNullReport(args: NullArgs): Promise<NullReport> {
  const verify = await verifyManifest(args.datasetDir);
  if (!verify.ok) throw new Error(`Dataset manifest verification failed for: ${verify.mismatches.join(', ')}`);
  const manifest = loadManifest(args.datasetDir);
  const symbols = manifest.symbols;

  const data: SymbolData[] = symbols.map((symbol) =>
    loadSymbolData(args.datasetDir, symbol, args.interval, {
      allowLockbox: false,
      start: args.start,
      end: args.end,
    })
  );
  for (const d of data) assertBeforeLockbox(d.matrix.timestamps);
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
  const minShiftBars = minShiftBarsOf(args.minShiftDays, args.interval);
  const offsets = drawOffsets(args.seed, args.draws, barCounts, minShiftBars);

  const fwd = new Map<number, Float64Array[]>();
  for (const h of args.horizons) {
    fwd.set(h, data.map((d) => symbolForwardReturns(d, h, args.executionLagBars, args.returnSeries)));
  }

  const cells: NullCell[] = [];
  for (const factor of args.factors) {
    const columns: Array<ArrayLike<number> | null> = data.map((d) => {
      const idx = d.matrix.names.indexOf(factor);
      return idx === -1 ? null : d.matrix.values[idx];
    });

    const nullIc = new Map<number, number[]>();
    const nullAbsT = new Map<number, number[]>();
    for (const h of args.horizons) {
      nullIc.set(h, []);
      nullAbsT.set(h, []);
    }
    for (let d = 0; d < args.draws; d++) {
      const shifted = columns.map((col, s) => (col ? shiftColumn(col, offsets[d][s]) : null));
      for (const h of args.horizons) {
        const stat = pooledHorizonStat(shifted, fwd.get(h)!, h);
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
        };
      }
      if (!args.nullOnly) {
        const obs = pooledHorizonStat(columns, fwd.get(h)!, h);
        if (obs) {
          cell.observedIc = obs.ic;
          cell.observedT = obs.icT;
          cell.empiricalP = absT.length === 0 ? null : (1 + absT.filter((v) => v >= Math.abs(obs.icT)).length) / (1 + args.draws);
        } else {
          const reason = 'observed cell has no statistic factor-ic would keep';
          console.error(`[qh-flow-null] ${factor} h=${h}: ${reason}`);
          cell.observedIc = null;
          cell.observedT = null;
          cell.empiricalP = null;
          cell.reason = cell.reason ? `${cell.reason}; ${reason}` : reason;
        }
      }
      cells.push(cell);
    }
  }

  return {
    args,
    datasetManifestHash: manifest.datasetHash,
    commit: resolveCommit(),
    symbols,
    barCounts,
    minShiftBars,
    offsets,
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
