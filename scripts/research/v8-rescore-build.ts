/**
 * Builds the v8 historical re-score rows (spec: header of scripts/research/v8-rescore.ts).
 *
 *   npx tsx scripts/research/v8-rescore-build.ts --dataset-dir <dir> --out <rows.jsonl.gz> [--symbols A,B]
 *
 * Reads only the exported research dataset (never a database, never the network). One symbol and one
 * interval at a time, so the largest live object is a single 5m factor matrix. Writes a gzipped JSONL
 * file ordered like scripts/ops/export-live-outcomes.ts and prints { rows, dropped, sha256, byCell }.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapToSnapshotInterval } from '@/lib/backtest/snapshot-series';
import { intervalToMs } from '@/lib/intervals';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { getTier } from '@/lib/signals/scorer';
import type { TradingStyle } from '@/lib/models/signal-template';
import { serializeRows } from '../ops/export-live-outcomes';
import type { SnapshotRow } from './dataset-format';
import { computeFactorMatrix } from './factors';
import { loadCandles, loadHtf, loadManifest, loadSnapshots } from './load-dataset';
import type { LiveRow } from './live-record-stats';
import {
  V8_RESCORE_CELLS,
  V8_RESCORE_CONFIG_VERSION,
  V8_RESCORE_WINDOW,
} from './v8-rescore';

export interface BuildArgs {
  datasetDir: string;
  out: string;
  symbols: string[];
}

export function parseArgs(argv: string[]): BuildArgs {
  let datasetDir: string | null = null;
  let out: string | null = null;
  let symbols: string[] = [...SIGNAL_SYMBOLS];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === '--dataset-dir') datasetDir = value();
    else if (flag === '--out') out = value();
    else if (flag === '--symbols') {
      symbols = value()
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (symbols.length === 0) throw new Error('--symbols: empty list');
    } else throw new Error(`Unknown flag "${flag}"`);
  }
  if (!datasetDir) throw new Error('--dataset-dir is required');
  if (!out) throw new Error('--out is required');
  return { datasetDir, out, symbols };
}

/**
 * The live resolver's outcome (src/lib/signals/outcome-resolver.ts): close-to-close percent from the bar at
 * index `i` to the close `horizonBars` later, or null when fewer than horizonBars bars follow or they are
 * not exactly consecutive at the interval.
 */
export function forwardReturnAt(
  timestamps: ArrayLike<number>,
  closes: ArrayLike<number>,
  i: number,
  horizonBars: number,
  intervalMs: number
): number | null {
  if (i + horizonBars >= timestamps.length) return null;
  const t0 = timestamps[i];
  for (let k = 1; k <= horizonBars; k++) {
    if (timestamps[i + k] !== t0 + k * intervalMs) return null;
  }
  const entry = closes[i];
  const exit = closes[i + horizonBars];
  const r = ((exit - entry) / entry) * 100;
  return Number.isFinite(r) ? r : null;
}

export interface CellRowsInput {
  symbol: string;
  interval: string;
  style: string;
  horizonBars: number;
  timestamps: ArrayLike<number>;
  closes: ArrayLike<number>;
  composite: ArrayLike<number>;
  window?: { start: string; end: string };
}

/** Rows for every bar with a finite composite inside the window; rows without an outcome are dropped and counted. */
export function buildCellRows(input: CellRowsInput): { rows: LiveRow[]; dropped: number } {
  const win = input.window ?? V8_RESCORE_WINDOW;
  const startMs = Date.parse(win.start);
  const endMs = Date.parse(win.end);
  const intervalMs = intervalToMs(input.interval);
  const rows: LiveRow[] = [];
  let dropped = 0;
  for (let i = 0; i < input.timestamps.length; i++) {
    const t = input.timestamps[i];
    if (t < startMs || t > endMs) continue;
    const score = input.composite[i];
    if (!Number.isFinite(score)) continue;
    const fwd = forwardReturnAt(input.timestamps, input.closes, i, input.horizonBars, intervalMs);
    if (fwd === null) {
      dropped++;
      continue;
    }
    rows.push({
      symbol: input.symbol,
      interval: input.interval,
      tradingStyle: input.style,
      tier: getTier(score),
      score,
      configVersion: V8_RESCORE_CONFIG_VERSION,
      candleTimestamp: t,
      horizonBars: input.horizonBars,
      forwardReturnPercent: fwd,
    });
  }
  return { rows, dropped };
}

/** Matrix for one symbol and cell, from the dataset start (warmup), lockbox allowed. Only the inputs the composite reads. */
export function loadCellMatrix(datasetDir: string, symbol: string, interval: string, style: TradingStyle) {
  const opts = { allowLockbox: true };
  const candles = loadCandles(datasetDir, symbol, interval, opts).rows;
  const htf = loadHtf(datasetDir, symbol, interval, opts).rows;
  const snapshotInterval = mapToSnapshotInterval(interval);
  const snapshotPath = join(datasetDir, 'snapshots', symbol, `${snapshotInterval}.jsonl.gz`);
  const snapshots: SnapshotRow[] | null = existsSync(snapshotPath)
    ? loadSnapshots(datasetDir, symbol, snapshotInterval, opts).rows
    : null;
  if (snapshots === null) console.error(`[v8-rescore] ${symbol}: no ${snapshotInterval} snapshot file, snapshots=null`);
  let lsRows1h: SnapshotRow[] | null = null;
  if (snapshotInterval !== '1h') {
    const lsPath = join(datasetDir, 'snapshots', symbol, '1h.jsonl.gz');
    lsRows1h = existsSync(lsPath) ? loadSnapshots(datasetDir, symbol, '1h', opts).rows : [];
  }
  return computeFactorMatrix({ candles, snapshots, lsRows1h, htf, interval, style });
}

export interface BuildResult {
  rows: number;
  dropped: number;
  sha256: string;
  byCell: Record<string, { rows: number; dropped: number }>;
}

export function buildAll(args: BuildArgs): BuildResult & { gz: Buffer } {
  const manifest = loadManifest(args.datasetDir);
  console.error(`[v8-rescore] dataset ${manifest.datasetHash}`);
  const all: LiveRow[] = [];
  const byCell: BuildResult['byCell'] = {};
  let dropped = 0;
  for (const cell of V8_RESCORE_CELLS) {
    const key = `${cell.style}|${cell.interval}`;
    byCell[key] = { rows: 0, dropped: 0 };
    for (const symbol of args.symbols) {
      const matrix = loadCellMatrix(args.datasetDir, symbol, cell.interval, cell.style);
      const compositeIdx = matrix.names.indexOf('composite');
      const built = buildCellRows({
        symbol,
        interval: cell.interval,
        style: cell.style,
        horizonBars: cell.horizonBars,
        timestamps: matrix.timestamps,
        closes: matrix.closes,
        composite: matrix.values[compositeIdx],
      });
      for (const r of built.rows) all.push(r);
      byCell[key].rows += built.rows.length;
      byCell[key].dropped += built.dropped;
      dropped += built.dropped;
      console.error(`[v8-rescore] ${key} ${symbol}: ${built.rows.length} rows, ${built.dropped} dropped`);
    }
  }
  const { rows: sorted, gz, sha256 } = serializeRows(all);
  return { rows: sorted.length, dropped, sha256, byCell, gz };
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { gz, ...summary } = buildAll(args);
    writeFileSync(args.out, gz);
    console.log(JSON.stringify(summary));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
