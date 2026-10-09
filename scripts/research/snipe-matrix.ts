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
 *   - The lockbox is always applied by the loaders; allowLockbox is never passed.
 *
 * Memory: the factor matrix (about 150 Float64 columns) is the peak. It is released as soon as the 38 columns are
 * reduced, and the labels are computed after that.
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
}

function perpFileExists(datasetDir: string, symbol: string, interval: string, series: 'klines' | 'premiumIndex'): boolean {
  const name = series === 'klines' ? `${interval}.jsonl.gz` : `${interval}.premiumIndex.jsonl.gz`;
  return existsSync(join(datasetDir, 'perp', symbol, name));
}

function requirePerp(datasetDir: string, symbol: string, interval: string): PerpCandleRow[] {
  if (!perpFileExists(datasetDir, symbol, interval, 'klines')) {
    throw new Error(`snipe: no perp ${interval} klines for ${symbol} in ${datasetDir}`);
  }
  return loadPerp(datasetDir, symbol, interval, 'klines').rows;
}

interface Built {
  matrix: FactorMatrix;
  entryBars: OHLCV[];
  pathBars: OHLCV[];
}

function buildMatrix(datasetDir: string, symbol: string, interval: string): Built {
  const perpRows = requirePerp(datasetDir, symbol, interval);
  const entryBars = perpRows.map(toOHLCV);
  const pathBars = interval === '5m' ? entryBars : requirePerp(datasetDir, symbol, '5m').map(toOHLCV);

  const style = styleForInterval(interval);
  const htfInterval = getConfirmationInterval(interval, style);
  let htfCandles: OHLCV[] = [];
  if (htfInterval) {
    if (perpFileExists(datasetDir, symbol, htfInterval, 'klines')) {
      htfCandles = loadPerp(datasetDir, symbol, htfInterval, 'klines').rows.map(toOHLCV);
    } else {
      console.error(`[snipe] ${symbol}: no perp ${htfInterval} klines, HTF context is null at ${interval}`);
    }
  }
  const htf = buildHtfRows(symbol, interval, entryBars, htfInterval, htfCandles, getStyleConfig(style).config);

  const snapshotInterval = mapToSnapshotInterval(interval);
  let snapshots: SnapshotRow[] | null = null;
  if (existsSync(join(datasetDir, 'snapshots', symbol, `${snapshotInterval}.jsonl.gz`))) {
    snapshots = loadSnapshots(datasetDir, symbol, snapshotInterval).rows;
  } else {
    console.error(`[snipe] ${symbol}: no ${snapshotInterval} snapshot file, snapshots=null`);
  }

  let metrics: MetricsRow[] | null = null;
  if (existsSync(join(datasetDir, 'metrics', symbol, '5m.jsonl.gz'))) {
    metrics = loadMetrics(datasetDir, symbol).rows;
  } else {
    console.error(`[snipe] ${symbol}: no futures metrics file, archive columns are NaN`);
  }

  let premiumIndex: PerpCandleRow[] | null = null;
  if (perpFileExists(datasetDir, symbol, interval, 'premiumIndex')) {
    premiumIndex = loadPerp(datasetDir, symbol, interval, 'premiumIndex').rows;
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

export function buildSymbolArrays(datasetDir: string, symbol: string, timeframe: SnipeTimeframe): SnipeSymbolArrays {
  const { interval, maxHoldMs } = SNIPE_TIMEFRAMES[timeframe];
  const intervalMs = intervalToMs(interval);
  const built = buildMatrix(datasetDir, symbol, interval);
  let matrix: FactorMatrix | null = built.matrix;

  const n = matrix.timestamps.length;
  const timestamps = Float64Array.from(matrix.timestamps);
  const warmupBars = matrix.warmupBars;
  const columns: string[] = [...SNIPE_COLUMNS];
  const flags: Uint8Array[] = [];
  const finiteShare: number[] = [];

  for (const name of columns) {
    const idx = matrix.names.indexOf(name);
    if (idx === -1) throw new Error(`snipe: column ${name} missing from the factor matrix for ${symbol} ${interval}`);
    const values = matrix.values[idx];
    let finite = 0;
    for (let i = 0; i < n; i++) if (Number.isFinite(values[i])) finite++;
    finiteShare.push(n === 0 ? 0 : finite / n);
    const thresholds = monthlyThresholds(timestamps, values, TAIL_PROBS, SNIPE_THRESHOLD_LOOKBACK_DAYS, intervalMs);
    flags.push(tailFlags(timestamps, values, thresholds));
  }
  // Release the matrix before the labels are computed.
  matrix = null;

  const labels = labelEntries({
    entryBars: built.entryBars,
    entryIntervalMs: intervalMs,
    pathBars: built.pathBars,
    maxHoldMs,
    atrPeriod: SNIPE_ATR_PERIOD,
    barrierAtr: SNIPE_BARRIER_ATR,
    sliceEndMs: Date.parse(SNIPE_LOCKBOX_START) - 1,
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
  };
}
