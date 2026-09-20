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
import { readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import mongoose from 'mongoose';
import { Candle, type ICandle } from '@/lib/models/candle';
import {
  HistoricalSnapshot,
  type IHistoricalSnapshot,
} from '@/lib/models/historical-snapshot';
import { PerpCandle, PERP_SERIES, type IPerpCandle, type PerpSeries } from '@/lib/models/perp-candle';
import { FuturesMetric, type IFuturesMetric } from '@/lib/models/futures-metric';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import {
  alignHtfToLtf,
  computeHtfSeries,
  getConfirmationInterval,
  htfContextAtBar,
} from '@/lib/signals/htf';
import { intervalToMs } from '@/lib/intervals';
import { getStyleConfig } from '@/lib/indicators/style-configs';
import type { IndicatorConfig } from '@/lib/indicators/types';
import type { OHLCV } from '@/types/market';
import {
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type DatasetKind,
  type HtfRow,
  type ManifestFile,
  type MetricsRow,
  type PerpCandleRow,
  type SnapshotRow,
} from './dataset-format';
import { styleForInterval } from './factors';

const DEFAULT_INTERVALS = ['5m', '15m', '1h', '4h', '1d'];
const SNAPSHOT_INTERVALS = new Set(['1h', '4h', '1d']);
const ALL_KINDS: readonly DatasetKind[] = ['candles', 'snapshots', 'htf', 'perp', 'metrics'] as const;
/** The archive publishes one 5m grid per symbol, so metrics has a single file. */
const METRICS_INTERVAL = '5m';
// Margin added on top of the style's own longest indicator lookback when
// fetching HTF warmup candles by count (see fetchCandlesBefore).
const HTF_WARMUP_MARGIN = 50;

/**
 * The longest lookback computeHtfSeries's own indicators need (EMA slow,
 * SMA long -- see src/lib/signals/htf.ts; SuperTrend's minimum, currently
 * 11 candles, is far smaller and never the binding constraint).
 */
function longestHtfLookback(config: IndicatorConfig): number {
  return Math.max(config.ema.slow, config.sma.long);
}

export interface ExportArgs {
  symbols: string[];
  intervals: string[];
  /** Which dataset kinds to write. A partial list leaves the other files alone. */
  kinds: DatasetKind[];
  /** Which PerpCandle series to export, when `perp` is among the kinds. */
  perpSeries: PerpSeries[];
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

  const kinds = flags.has('datasets')
    ? parseList(flags.get('datasets')!).map((kind) => {
        if (!(ALL_KINDS as readonly string[]).includes(kind)) {
          throw new Error(`Unknown dataset kind "${kind}", expected one of ${ALL_KINDS.join(', ')}`);
        }
        return kind as DatasetKind;
      })
    : [...ALL_KINDS];

  const perpSeries = flags.has('perp-series')
    ? parseList(flags.get('perp-series')!).map((series) => {
        if (!(PERP_SERIES as readonly string[]).includes(series)) {
          throw new Error(`Unknown perp series "${series}", expected one of ${PERP_SERIES.join(', ')}`);
        }
        return series as PerpSeries;
      })
    : ['klines' as PerpSeries];

  return {
    symbols: flags.has('symbols') ? parseList(flags.get('symbols')!) : [...SIGNAL_SYMBOLS],
    intervals: flags.has('intervals') ? parseList(flags.get('intervals')!) : [...DEFAULT_INTERVALS],
    kinds,
    perpSeries,
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

function candleDocToOHLCV(doc: ICandle): OHLCV {
  return {
    timestamp: doc.timestamp,
    open: doc.open,
    high: doc.high,
    low: doc.low,
    close: doc.close,
    volume: doc.volume,
    ...(doc.takerBuyVolume !== undefined ? { takerBuyVolume: doc.takerBuyVolume } : {}),
  };
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
    rows.push(candleDocToOHLCV(doc));
  }
  return rows;
}

/**
 * Fetches up to `count` candles strictly before `before`, sorted ascending
 * -- a bar-count warmup fetch rather than a time-range one, so gaps in the
 * underlying data cannot starve the indicator warmup the way subtracting a
 * fixed duration from `before` could. Returns fewer than `count` rows when
 * fewer exist.
 */
async function fetchCandlesBefore(
  symbol: string,
  interval: string,
  before: number,
  count: number
): Promise<OHLCV[]> {
  if (count <= 0) return [];

  const rows: OHLCV[] = [];
  const cursor = Candle.find({ symbol, interval, timestamp: { $lt: before } })
    .sort({ timestamp: -1 })
    .limit(count)
    .lean()
    .cursor();
  for await (const doc of cursor as AsyncIterable<ICandle>) {
    rows.push(candleDocToOHLCV(doc));
  }
  return rows.reverse();
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
 *
 * `config` must be the indicator config for the LTF interval's own trading
 * style (getStyleConfig(styleForInterval(ltfInterval)).config), matching
 * live scoring (src/lib/signals/compute-engine.ts calls
 * computeHtfSeries(closed, profile.config) with that same style's profile).
 * Passing computeHtfSeries's own DEFAULT_CONFIG default here instead would
 * silently use day_trading's EMA/SMA periods (12/26, 50/200) for every
 * other style's HTF context -- wrong for 5m (scalping, 5/13, 20/50) and 4h
 * (swing, 21/55) in particular.
 */
export function buildHtfRows(
  symbol: string,
  ltfInterval: string,
  ltfCandles: OHLCV[],
  htfInterval: string | null,
  htfCandles: OHLCV[],
  config: IndicatorConfig
): HtfRow[] {
  if (!htfInterval || ltfCandles.length === 0) {
    return ltfCandles.map((candle) => ({ t: candle.timestamp, context: null }));
  }

  let series: ReturnType<typeof computeHtfSeries>;
  try {
    series = computeHtfSeries(htfCandles, config);
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

/** Null unless the stored value is a real number, so a gap never reads as zero. */
function orNull(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

/**
 * Perpetual bars for one symbol, interval and series, through a cursor for the
 * same reason fetchCandles uses one: a year of 5m bars is past any find() cap.
 */
async function fetchPerpCandles(
  symbol: string,
  interval: string,
  series: PerpSeries,
  startMs?: number,
  endMs?: number
): Promise<PerpCandleRow[]> {
  const timestamp = buildTimestampFilter(startMs, endMs);
  const query: Record<string, unknown> = { symbol, interval, series };
  if (timestamp) query.timestamp = timestamp;

  const rows: PerpCandleRow[] = [];
  const cursor = PerpCandle.find(query).sort({ timestamp: 1 }).lean().cursor();
  for await (const doc of cursor as AsyncIterable<IPerpCandle>) {
    rows.push({
      t: doc.timestamp,
      o: doc.open,
      h: doc.high,
      l: doc.low,
      c: doc.close,
      v: doc.volume,
      qv: doc.quoteVolume,
      n: doc.trades,
      tbv: orNull(doc.takerBuyVolume),
    });
  }
  return rows;
}

/** The 5m futures-metrics grid for one symbol. One file, every interval reads it. */
async function fetchFuturesMetrics(
  symbol: string,
  startMs?: number,
  endMs?: number
): Promise<MetricsRow[]> {
  const timestamp = buildTimestampFilter(startMs, endMs);
  const query: Record<string, unknown> = { symbol };
  if (timestamp) query.timestamp = timestamp;

  const rows: MetricsRow[] = [];
  const cursor = FuturesMetric.find(query).sort({ timestamp: 1 }).lean().cursor();
  for await (const doc of cursor as AsyncIterable<IFuturesMetric>) {
    rows.push({
      t: doc.timestamp,
      openInterest: orNull(doc.openInterest),
      openInterestValue: orNull(doc.openInterestValue),
      topTraderAccountRatio: orNull(doc.topTraderAccountRatio),
      topTraderPositionRatio: orNull(doc.topTraderPositionRatio),
      globalAccountRatio: orNull(doc.globalAccountRatio),
      takerLongShortRatio: orNull(doc.takerLongShortRatio),
      depthImbalance1: orNull(doc.depthImbalance1),
      depthImbalance2: orNull(doc.depthImbalance2),
      depthImbalance5: orNull(doc.depthImbalance5),
      depthNotional1: orNull(doc.depthNotional1),
      depthNotional5: orNull(doc.depthNotional5),
    });
  }
  return rows;
}

/** Matches loadPerp: the traded series keeps the bare interval name. */
function perpFileName(interval: string, series: PerpSeries): string {
  return series === 'klines' ? `${interval}.jsonl.gz` : `${interval}.${series}.jsonl.gz`;
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

/**
 * The existing manifest's files with this run's entries replacing theirs by
 * path, or just this run's when there is no manifest to merge into. An
 * unreadable manifest is treated as absent rather than fatal: a fresh export
 * into a directory holding a corrupt one should still succeed.
 */
export function mergeManifestFiles(outDir: string, written: ManifestFile[]): ManifestFile[] {
  let existing: ManifestFile[] = [];
  try {
    const raw = readFileSync(join(outDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as DatasetManifest;
    existing = Array.isArray(parsed.files) ? parsed.files : [];
  } catch {
    return [...written];
  }

  const rewritten = new Set(written.map((f) => f.path));
  const kept = existing.filter((f) => !rewritten.has(f.path));
  return [...kept, ...written].sort((a, b) => a.path.localeCompare(b.path));
}

function unionSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
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

    const kinds = new Set(args.kinds);

    for (const symbol of args.symbols) {
      // One 5m grid per symbol, outside the interval loop: every interval's
      // factors align onto the same file rather than getting a copy each.
      if (kinds.has('metrics')) {
        const metricsRows = await fetchFuturesMetrics(symbol, args.start, args.end);
        files.push(
          await writeDatasetFile(
            args.out,
            `metrics/${symbol}/${METRICS_INTERVAL}.jsonl.gz`,
            'metrics',
            symbol,
            METRICS_INTERVAL,
            metricsRows,
            (row) => row.t
          )
        );
      }

      for (const interval of args.intervals) {
        // HTF rows are index-aligned to the LTF candles, so the candle read
        // happens whenever either kind is being written.
        const needsCandles = kinds.has('candles') || kinds.has('htf');
        const ltfCandles = needsCandles ? await fetchCandles(symbol, interval, args.start, args.end) : [];

        if (kinds.has('candles')) {
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
        }

        if (kinds.has('perp')) {
          for (const series of args.perpSeries) {
            const perpRows = await fetchPerpCandles(symbol, interval, series, args.start, args.end);
            files.push(
              await writeDatasetFile(
                args.out,
                `perp/${symbol}/${perpFileName(interval, series)}`,
                'perp',
                symbol,
                interval,
                perpRows,
                (row) => row.t
              )
            );
          }
        }

        if (kinds.has('snapshots') && SNAPSHOT_INTERVALS.has(interval)) {
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

        if (!kinds.has('htf')) continue;

        // The LTF interval's own trading style resolves both which config
        // computeHtfSeries uses (must match live scoring's profile.config
        // for that style) and how many HTF warmup bars it needs.
        const style = styleForInterval(interval);
        const styleConfig = getStyleConfig(style).config;

        const htfInterval = getConfirmationInterval(interval, style);
        let htfCandles: OHLCV[] = [];
        if (htfInterval) {
          const warmupBarsNeeded = longestHtfLookback(styleConfig) + HTF_WARMUP_MARGIN;
          const warmupCandles =
            args.start !== undefined
              ? await fetchCandlesBefore(symbol, htfInterval, args.start, warmupBarsNeeded)
              : [];
          const mainRangeCandles = await fetchCandles(symbol, htfInterval, args.start, args.end);
          htfCandles = [...warmupCandles, ...mainRangeCandles];
        }

        const htfRows = buildHtfRows(symbol, interval, ltfCandles, htfInterval, htfCandles, styleConfig);
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

    // A partial run (--datasets, --symbols, --intervals) must not drop the
    // files it did not rewrite: the manifest is the dataset's index, and
    // rebuilding it from this run alone would orphan everything else on disk
    // and change the dataset hash to describe a fraction of it. Entries this
    // run rewrote are replaced by path; the rest are carried over.
    const merged = mergeManifestFiles(args.out, files);

    const manifest: DatasetManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      commit: resolveCommit(),
      lockboxStart: LOCKBOX_START_ISO,
      symbols: unionSorted(merged.map((f) => f.symbol)),
      intervals: unionSorted(merged.map((f) => f.interval)),
      files: merged,
      datasetHash: datasetHashOf(merged),
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
