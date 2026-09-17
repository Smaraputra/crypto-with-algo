/**
 * Exports Candle, HistoricalSnapshot, and derived HTF-confluence data from
 * MongoDB into the hashed, gitignored research dataset under data/research/.
 *
 * Usage:
 *   npx tsx scripts/research/export-dataset.ts
 *   npx tsx scripts/research/export-dataset.ts --symbols BTCUSDT,ETHUSDT --intervals 1h,4h
 *   npx tsx scripts/research/export-dataset.ts --start 2025-01-01 --end 2026-06-30 --out data/research
 *
 * Requires MONGODB_URI (or --mongo-uri) pointing at the source database.
 */

import { execFileSync } from 'child_process';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import mongoose from 'mongoose';
import { Candle, type ICandle } from '@/lib/models/candle';
import {
  HistoricalSnapshot,
  type IHistoricalSnapshot,
} from '@/lib/models/historical-snapshot';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import {
  alignHtfToLtf,
  computeHtfSeries,
  getConfirmationInterval,
  htfContextAtBar,
} from '@/lib/signals/htf';
import { intervalToMs } from '@/lib/intervals';
import type { OHLCV } from '@/types/market';
import {
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type HtfRow,
  type ManifestFile,
  type SnapshotRow,
} from './dataset-format';

const DEFAULT_INTERVALS = ['5m', '15m', '1h', '4h', '1d'];
const SNAPSHOT_INTERVALS = new Set(['1h', '4h', '1d']);
const HTF_WARMUP_BARS = 250;

export interface ExportArgs {
  symbols: string[];
  intervals: string[];
  start?: number;
  end?: number;
  out: string;
  mongoUri: string;
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseIsoFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid --${name} date: ${value}`);
  }
  return ms;
}

/**
 * Pure CLI argument parsing. `env` is injectable so tests never depend on the
 * process's real MONGODB_URI.
 */
export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): ExportArgs {
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`Missing value for --${key}`);
      }
      flags.set(key, value);
      i++;
    }
  }

  return {
    symbols: flags.has('symbols') ? parseList(flags.get('symbols')!) : [...SIGNAL_SYMBOLS],
    intervals: flags.has('intervals') ? parseList(flags.get('intervals')!) : [...DEFAULT_INTERVALS],
    start: parseIsoFlag(flags.get('start'), 'start'),
    end: parseIsoFlag(flags.get('end'), 'end'),
    out: flags.get('out') ?? 'data/research',
    mongoUri: flags.get('mongo-uri') ?? env.MONGODB_URI ?? '',
  };
}

function buildTimestampFilter(startMs?: number, endMs?: number): Record<string, number> | undefined {
  const filter: Record<string, number> = {};
  if (startMs !== undefined) filter.$gte = startMs;
  if (endMs !== undefined) filter.$lte = endMs;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

/**
 * Reads candles through a Mongoose cursor sorted ascending, deliberately not
 * getCandles (src/lib/candle-ingestion.ts), which caps reads at 50,000 rows.
 */
async function fetchCandles(
  symbol: string,
  interval: string,
  startMs?: number,
  endMs?: number
): Promise<OHLCV[]> {
  const filter: Record<string, unknown> = { symbol, interval };
  const timestampFilter = buildTimestampFilter(startMs, endMs);
  if (timestampFilter) filter.timestamp = timestampFilter;

  const rows: OHLCV[] = [];
  const cursor = Candle.find(filter).sort({ timestamp: 1 }).lean().cursor();
  for await (const doc of cursor as AsyncIterable<ICandle>) {
    rows.push({
      timestamp: doc.timestamp,
      open: doc.open,
      high: doc.high,
      low: doc.low,
      close: doc.close,
      volume: doc.volume,
      ...(doc.takerBuyVolume !== undefined ? { takerBuyVolume: doc.takerBuyVolume } : {}),
    });
  }
  return rows;
}

function toCandleRow(candle: OHLCV): CandleRow {
  return {
    t: candle.timestamp,
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
    v: candle.volume,
    tbv: candle.takerBuyVolume ?? null,
  };
}

/** Snapshots exist only at 1h/4h/1d; mapped from data.* with null where absent. */
async function fetchSnapshots(
  symbol: string,
  interval: string,
  startMs?: number,
  endMs?: number
): Promise<SnapshotRow[]> {
  const filter: Record<string, unknown> = { symbol, interval };
  const timestampFilter = buildTimestampFilter(startMs, endMs);
  if (timestampFilter) filter.timestamp = timestampFilter;

  const rows: SnapshotRow[] = [];
  const cursor = HistoricalSnapshot.find(filter).sort({ timestamp: 1 }).lean().cursor();
  for await (const doc of cursor as AsyncIterable<IHistoricalSnapshot>) {
    const data = doc.data ?? {};
    rows.push({
      t: doc.timestamp,
      fundingRate: data.fundingRate
        ? { rate: data.fundingRate.rate, markPrice: data.fundingRate.markPrice ?? null }
        : null,
      longShortRatio: data.longShortRatio
        ? {
            ratio: data.longShortRatio.ratio,
            longAccount: data.longShortRatio.longAccount,
            shortAccount: data.longShortRatio.shortAccount,
          }
        : null,
      openInterest: data.openInterest
        ? { value: data.openInterest.value, sumValue: data.openInterest.sumValue }
        : null,
      fearGreed: data.fearGreed
        ? { index: data.fearGreed.index, label: data.fearGreed.label }
        : null,
      newsSentiment: data.newsSentiment
        ? {
            count: data.newsSentiment.count,
            avgSentiment: data.newsSentiment.avgSentiment,
            topics: data.newsSentiment.topics ?? [],
          }
        : null,
    });
  }
  return rows;
}

/**
 * One HTF row per LTF candle: null context before warmup, before any HTF bar
 * has closed, when the interval has no confirmation timeframe, or when there
 * are too few HTF candles for the underlying indicators (computeHtfSeries's
 * SuperTrend throws below its own minimum, currently 11 candles). All of
 * these degrade to null contexts rather than aborting the export, since a
 * sparse confirmation interval for one symbol/interval must not lose the
 * candle and snapshot data already fetched for every other pair.
 */
function buildHtfRows(
  symbol: string,
  ltfInterval: string,
  ltfCandles: OHLCV[],
  htfInterval: string | null,
  htfCandles: OHLCV[]
): HtfRow[] {
  if (!htfInterval || ltfCandles.length === 0) {
    return ltfCandles.map((candle) => ({ t: candle.timestamp, context: null }));
  }

  let series: ReturnType<typeof computeHtfSeries>;
  try {
    series = computeHtfSeries(htfCandles);
  } catch (error) {
    console.warn(
      `HTF context unavailable for ${symbol} ${ltfInterval} ` +
        `(${htfCandles.length} ${htfInterval} candles): ` +
        `${error instanceof Error ? error.message : 'unknown error'}`
    );
    return ltfCandles.map((candle) => ({ t: candle.timestamp, context: null }));
  }

  const map = alignHtfToLtf(
    ltfCandles,
    intervalToMs(ltfInterval),
    htfCandles,
    intervalToMs(htfInterval)
  );

  return ltfCandles.map((candle, i) => {
    const htfBar = map[i];
    const context = htfBar === -1 ? null : htfContextAtBar(series, htfBar, htfInterval);
    return { t: candle.timestamp, context };
  });
}

async function writeDatasetFile<T>(
  outDir: string,
  relPath: string,
  kind: ManifestFile['kind'],
  symbol: string,
  interval: string,
  rows: T[],
  timestampOf: (row: T) => number
): Promise<ManifestFile> {
  const fullPath = join(outDir, relPath);
  await writeJsonlGz(fullPath, rows);
  const sha256 = await sha256File(fullPath);

  const file: ManifestFile = {
    path: relPath,
    kind,
    symbol,
    interval,
    rowCount: rows.length,
    startMs: rows.length > 0 ? timestampOf(rows[0]) : null,
    endMs: rows.length > 0 ? timestampOf(rows[rows.length - 1]) : null,
    sha256,
  };

  console.log(JSON.stringify(file));
  return file;
}

function resolveCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

export async function runExport(args: ExportArgs): Promise<DatasetManifest> {
  if (!args.mongoUri) {
    throw new Error('A MongoDB URI is required (--mongo-uri or MONGODB_URI)');
  }

  await mongoose.connect(args.mongoUri);

  try {
    const files: ManifestFile[] = [];

    for (const symbol of args.symbols) {
      for (const interval of args.intervals) {
        const ltfCandles = await fetchCandles(symbol, interval, args.start, args.end);
        files.push(
          await writeDatasetFile(
            args.out,
            `candles/${symbol}/${interval}.jsonl.gz`,
            'candles',
            symbol,
            interval,
            ltfCandles.map(toCandleRow),
            (row) => row.t
          )
        );

        if (SNAPSHOT_INTERVALS.has(interval)) {
          const snapshotRows = await fetchSnapshots(symbol, interval, args.start, args.end);
          files.push(
            await writeDatasetFile(
              args.out,
              `snapshots/${symbol}/${interval}.jsonl.gz`,
              'snapshots',
              symbol,
              interval,
              snapshotRows,
              (row) => row.t
            )
          );
        }

        const htfInterval = getConfirmationInterval(interval);
        let htfCandles: OHLCV[] = [];
        if (htfInterval) {
          const htfMs = intervalToMs(htfInterval);
          const htfStart = args.start !== undefined ? args.start - HTF_WARMUP_BARS * htfMs : undefined;
          htfCandles = await fetchCandles(symbol, htfInterval, htfStart, args.end);
        }

        const htfRows = buildHtfRows(symbol, interval, ltfCandles, htfInterval, htfCandles);
        files.push(
          await writeDatasetFile(
            args.out,
            `htf/${symbol}/${interval}.jsonl.gz`,
            'htf',
            symbol,
            interval,
            htfRows,
            (row) => row.t
          )
        );
      }
    }

    const manifest: DatasetManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      commit: resolveCommit(),
      lockboxStart: LOCKBOX_START_ISO,
      symbols: args.symbols,
      intervals: args.intervals,
      files,
      datasetHash: datasetHashOf(files),
    };

    await writeFile(join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ path: 'manifest.json', datasetHash: manifest.datasetHash, fileCount: files.length }));

    return manifest;
  } finally {
    await mongoose.disconnect();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await runExport(args);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
