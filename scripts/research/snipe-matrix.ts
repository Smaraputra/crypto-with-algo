/**
 * Snipe phase per-symbol arrays (see snipe.ts). For ONE symbol and timeframe over the whole exported span:
 * the 38 SNIPE_COLUMNS reduced to tail flag bytes, the barrier labels, and the ATR quintile.
 *
 * Conventions copied, not invented:
 *   - Inputs and the computeFactorMatrix call follow loadSymbolData in factor-ic.ts: the matrix candles and `perp`
 *     are both the PERP klines (the instrument traded), snapshots come from the mapped snapshot interval (1h for
 *     both timeframes, so lsRows1h is never needed), metrics and premiumIndex are null when the dataset lacks the
 *     file (columns derived from them become NaN, with a stderr note), options are null (no options column is
 *     in SNIPE_COLUMNS). No start/end filter is applied, so the LS_Z_WARMUP_MS snapshot padding is moot: every
 *     snapshot row before the lockbox is loaded.
 *   - HTF rows follow export-dataset.ts: buildHtfRows with getStyleConfig(styleForInterval(interval)).config,
 *     the HTF interval from getConfirmationInterval, candles converted with toOHLCV. The HTF candles are perp
 *     klines at the HTF interval (the exported htf file is spot-based; the spec recomputes it from perp). A
 *     missing HTF perp file gives null contexts, with a stderr note.
 *   - The lockbox is applied by the loaders by default. The forward test (forward-test.ts) opts in per call with
 *     BuildOptions: loaders get allowLockbox, rows outside [startMs, endMs] are dropped before the matrix is
 *     built, and the labels' sliceEndMs is endMs. Without options the behaviour is exactly the original.
 *
 * Memory: the factor matrix (about 150 Float64 columns) is the peak. It lives only inside reduceColumns, so it is
 * released as soon as the 38 columns are reduced, and the labels are computed after that.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import { intervalToMs } from '@/lib/intervals';
import { mapToSnapshotInterval } from '@/lib/backtest/snapshot-series';
import { getConfirmationInterval } from '@/lib/signals/htf';
import type { OHLCV } from '@/types/market';
import { buildHtfRows } from './export-dataset';
import { computeFactorMatrix, styleForInterval, toOHLCV, type FactorMatrix } from './factors';
import { loadMetrics, loadPerp, loadSnapshots } from './load-dataset';
import type { MetricsRow, PerpCandleRow, SnapshotRow } from './dataset-format';
import { labelEntries } from './snipe-labels';
import { atrQuintiles, monthIndex, monthlyThresholds, tailFlags, TAIL_PROBS } from './snipe-tails';
import {
  SNIPE_ATR_PERIOD,
  SNIPE_BARRIER_ATR,
  SNIPE_COLUMNS,
  SNIPE_LOCKBOX_START,
  SNIPE_THRESHOLD_LOOKBACK_DAYS,
  SNIPE_TIMEFRAMES,
  type SnipeTimeframe,
} from './snipe';

export interface SnipeSymbolArrays {
  symbol: string;
  timeframe: SnipeTimeframe;
  /** The SNIPE_COLUMNS names, parallel to `flags` and `finiteShare`. */
  columns: string[];
  timestamps: Float64Array;
  /** One flag byte array per column (see snipe-tails.ts for the bits). */
  flags: Uint8Array[];
  outcome: Int8Array;
  entryMs: Float64Array;
  exitMs: Float64Array;
  atrPct: Float64Array;
  /** Entry bar open and ATR in price units of each label (NaN where none), and the data-hole flag (A1-5). */
  entryPrice: Float64Array;
  atrAbs: Float64Array;
  gap: Uint8Array;
  atrQuintile: Int8Array;
  month: Int32Array;
  warmupBars: number;
  /** Share of bars whose raw value is finite, per column. */
  finiteShare: number[];
  /** Only with BuildOptions.captureColumn: a copy of that column's raw values, parallel to `timestamps`. */
  captured?: { column: string; values: Float64Array };
}

function perpFileExists(datasetDir: string, symbol: string, interval: string, series: 'klines' | 'premiumIndex'): boolean {
  const name = series === 'klines' ? `${interval}.jsonl.gz` : `${interval}.premiumIndex.jsonl.gz`;
  return existsSync(join(datasetDir, 'perp', symbol, name));
}

/** Opt-in forward mode (see the file header). All fields optional, no field set means the original behaviour. */
export interface BuildOptions {
  allowLockbox?: boolean;
  startMs?: number;
  endMs?: number;
  /** Also return a copy of this SNIPE_COLUMNS column's raw values in `captured` (span-equality check). */
  captureColumn?: string;
}

function inRange<T extends { t: number }>(rows: T[], opts: BuildOptions): T[] {
  const lo = opts.startMs ?? -Infinity;
  const hi = opts.endMs ?? Infinity;
  if (lo === -Infinity && hi === Infinity) return rows;
  return rows.filter((r) => r.t >= lo && r.t <= hi);
}

function requirePerp(datasetDir: string, symbol: string, interval: string, opts: BuildOptions): PerpCandleRow[] {
  if (!perpFileExists(datasetDir, symbol, interval, 'klines')) {
    throw new Error(`snipe: no perp ${interval} klines for ${symbol} in ${datasetDir}`);
  }
  return inRange(loadPerp(datasetDir, symbol, interval, 'klines', { allowLockbox: opts.allowLockbox }).rows, opts);
}

interface Built {
  matrix: FactorMatrix;
  entryBars: OHLCV[];
  pathBars: OHLCV[];
}

function buildMatrix(datasetDir: string, symbol: string, interval: string, opts: BuildOptions): Built {
  const lo = { allowLockbox: opts.allowLockbox };
  const perpRows = requirePerp(datasetDir, symbol, interval, opts);
  const entryBars = perpRows.map(toOHLCV);
  const pathBars = interval === '5m' ? entryBars : requirePerp(datasetDir, symbol, '5m', opts).map(toOHLCV);

  const style = styleForInterval(interval);
  const htfInterval = getConfirmationInterval(interval, style);
  let htfCandles: OHLCV[] = [];
  if (htfInterval) {
    if (perpFileExists(datasetDir, symbol, htfInterval, 'klines')) {
      htfCandles = inRange(loadPerp(datasetDir, symbol, htfInterval, 'klines', lo).rows, opts).map(toOHLCV);
    } else {
      console.error(`[snipe] ${symbol}: no perp ${htfInterval} klines, HTF context is null at ${interval}`);
    }
  }
  const htf = buildHtfRows(symbol, interval, entryBars, htfInterval, htfCandles, getStyleConfig(style).config);

  const snapshotInterval = mapToSnapshotInterval(interval);
  let snapshots: SnapshotRow[] | null = null;
  if (existsSync(join(datasetDir, 'snapshots', symbol, `${snapshotInterval}.jsonl.gz`))) {
    snapshots = inRange(loadSnapshots(datasetDir, symbol, snapshotInterval, lo).rows, opts);
  } else {
    console.error(`[snipe] ${symbol}: no ${snapshotInterval} snapshot file, snapshots=null`);
  }

  let metrics: MetricsRow[] | null = null;
  if (existsSync(join(datasetDir, 'metrics', symbol, '5m.jsonl.gz'))) {
    metrics = inRange(loadMetrics(datasetDir, symbol, lo).rows, opts);
  } else {
    console.error(`[snipe] ${symbol}: no futures metrics file, archive columns are NaN`);
  }

  let premiumIndex: PerpCandleRow[] | null = null;
  if (perpFileExists(datasetDir, symbol, interval, 'premiumIndex')) {
    premiumIndex = inRange(loadPerp(datasetDir, symbol, interval, 'premiumIndex', lo).rows, opts);
  } else {
    console.error(`[snipe] ${symbol}: no ${interval} premiumIndex file, basis columns are NaN`);
  }

  const matrix = computeFactorMatrix({
    candles: perpRows,
    snapshots,
    lsRows1h: null,
    htf,
    interval,
    metrics,
    perp: perpRows,
    premiumIndex,
    options: null,
    marketOptions: null,
  });
  return { matrix, entryBars, pathBars };
}

interface Reduced {
  columns: string[];
  timestamps: Float64Array;
  flags: Uint8Array[];
  finiteShare: number[];
  warmupBars: number;
  entryBars: OHLCV[];
  pathBars: OHLCV[];
  captured?: { column: string; values: Float64Array };
}

/**
 * Builds the factor matrix and reduces it to the tail flags INSIDE this function, so the matrix is local and
 * unreachable as soon as it returns, and no holder object keeps it alive while the labels are computed.
 */
function reduceColumns(
  datasetDir: string,
  symbol: string,
  interval: string,
  intervalMs: number,
  opts: BuildOptions
): Reduced {
  const { matrix, entryBars, pathBars } = buildMatrix(datasetDir, symbol, interval, opts);
  const n = matrix.timestamps.length;
  const timestamps = Float64Array.from(matrix.timestamps);
  const columns: string[] = [...SNIPE_COLUMNS];
  const flags: Uint8Array[] = [];
  const finiteShare: number[] = [];
  let captured: Reduced['captured'];

  for (const name of columns) {
    const idx = matrix.names.indexOf(name);
    if (idx === -1) throw new Error(`snipe: column ${name} missing from the factor matrix for ${symbol} ${interval}`);
    const values = matrix.values[idx];
    if (opts.captureColumn === name) captured = { column: name, values: Float64Array.from(values) };
    let finite = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(values[i])) finite++;
    finiteShare.push(n === 0 ? 0 : finite / n);
    const thresholds = monthlyThresholds(timestamps, values, TAIL_PROBS, SNIPE_THRESHOLD_LOOKBACK_DAYS, intervalMs);
    flags.push(tailFlags(timestamps, values, thresholds));
  }
  if (opts.captureColumn !== undefined && captured === undefined) {
    throw new Error(`snipe: captureColumn ${opts.captureColumn} is not a SNIPE_COLUMNS column`);
  }
  return { columns, timestamps, flags, finiteShare, warmupBars: matrix.warmupBars, entryBars, pathBars, captured };
}

export function buildSymbolArrays(
  datasetDir: string,
  symbol: string,
  timeframe: SnipeTimeframe,
  options: BuildOptions = {}
): SnipeSymbolArrays {
  const { interval, maxHoldMs } = SNIPE_TIMEFRAMES[timeframe];
  const intervalMs = intervalToMs(interval);
  const { columns, timestamps, flags, finiteShare, warmupBars, entryBars, pathBars, captured } = reduceColumns(
    datasetDir,
    symbol,
    interval,
    intervalMs,
    options
  );
  const n = timestamps.length;

  const labels = labelEntries({
    entryBars,
    entryIntervalMs: intervalMs,
    pathBars,
    maxHoldMs,
    atrPeriod: SNIPE_ATR_PERIOD,
    barrierAtr: SNIPE_BARRIER_ATR,
    sliceEndMs: options.endMs ?? Date.parse(SNIPE_LOCKBOX_START) - 1,
  });
  const atrQuintile = atrQuintiles(timestamps, labels.atrPct, SNIPE_THRESHOLD_LOOKBACK_DAYS, intervalMs);
  const month = new Int32Array(n);
  for (let i = 0; i < n; i++) month[i] = monthIndex(timestamps[i]);

  return {
    symbol,
    timeframe,
    columns,
    timestamps,
    flags,
    outcome: labels.outcome,
    entryMs: labels.entryMs,
    exitMs: labels.exitMs,
    atrPct: labels.atrPct,
    entryPrice: labels.entryPrice,
    atrAbs: labels.atrAbs,
    gap: labels.gap,
    atrQuintile,
    month,
    warmupBars,
    finiteShare,
    ...(captured ? { captured } : {}),
  };
}
