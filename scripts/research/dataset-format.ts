/**
 * Pure data shapes and file I/O for the research dataset export.
 *
 * No Mongo/Mongoose imports here: this module is the shared contract between
 * export-dataset.ts (writes the dataset from MongoDB) and load-dataset.ts
 * (reads it back for research subagents), and stays a plain, dependency-free
 * format so both sides -- and any consumer that never touches Mongo -- agree
 * on it.
 */

import { createHash } from 'crypto';
import { createReadStream, createWriteStream, readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGzip, gunzipSync } from 'zlib';
import type { HtfContext } from '@/types/signal';

/** One row per stored candle. `tbv` is null on legacy candles without taker buy volume. */
export interface CandleRow {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  tbv: number | null;
}

/**
 * One row per stored historical snapshot. Each sub-shape mirrors the `data.*`
 * fields on IHistoricalSnapshot (src/lib/models/historical-snapshot.ts);
 * whatever the model marks optional is exported as null here instead of
 * being omitted, so every row has a stable, fully-keyed shape.
 */
export interface SnapshotRow {
  t: number;
  fundingRate: {
    rate: number;
    /** Null when Binance returned an empty markPrice (funding events before mid-2023). */
    markPrice: number | null;
  } | null;
  longShortRatio: {
    ratio: number;
    longAccount: number;
    shortAccount: number;
  } | null;
  openInterest: {
    value: number;
    sumValue: number;
  } | null;
  fearGreed: {
    index: number;
    label: string;
  } | null;
  newsSentiment: {
    count: number;
    avgSentiment: number;
    topics: string[];
  } | null;
}

/**
 * One row per LTF candle, index-aligned with the candle file of the same
 * symbol and interval. `context` is null during indicator warmup, before any
 * HTF bar has closed, or when the interval has no confirmation timeframe
 * (getConfirmationInterval returns null for 1d).
 */
export interface HtfRow {
  t: number;
  context: HtfContext | null;
}

/**
 * One row per perpetual bar from the Binance public data archive, written by
 * scripts/ops/ingest-archive.ts into PerpCandle.
 *
 * Kept separate from CandleRow because the two are different venues: candles/
 * holds SPOT bars while every backtest charges USDT-M perpetual fees, slippage
 * and funding. `series` distinguishes the traded bar from the premium index and
 * mark price series, on which only OHLC carries meaning (Binance writes zero
 * volume and zero taker volume on both).
 */
export interface PerpCandleRow {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Quote-asset volume, absent from the spot CandleRow shape. */
  qv: number;
  /** Trade count in the bar. */
  n: number;
  tbv: number | null;
}

/**
 * One row per 5m slot of FuturesMetric, the archive's positioning and
 * order-book series. Null where the archive had no value, never zero: an open
 * interest of 0 and an unknown open interest are different readings.
 *
 * These are the inputs the REST path could only reach for the last 30 days, so
 * before this dataset kind existed `SnapshotRow.longShortRatio` and
 * `.openInterest` were present on 11.0% of 1h bars and none before 2026-03-03.
 */
export interface MetricsRow {
  t: number;
  openInterest: number | null;
  openInterestValue: number | null;
  topTraderAccountRatio: number | null;
  topTraderPositionRatio: number | null;
  globalAccountRatio: number | null;
  takerLongShortRatio: number | null;
  depthImbalance1: number | null;
  depthImbalance2: number | null;
  depthImbalance5: number | null;
  depthNotional1: number | null;
  depthNotional5: number | null;
}

/**
 * One row per hourly OptionsFlowHour document (src/lib/models/options-flow-hour.ts):
 * the Deribit DVOL index and trade-flow aggregates for one currency. `t` is
 * the UTC hour OPEN, matching the stored document's `timestamp` and
 * OPTIONS_SLOT_MS (src/lib/options-flow.ts). Every field but `t` is
 * `number | null`, since either the dvol pass or the trades pass (or both)
 * may not have written a given hour yet.
 */
export interface OptionsRow {
  t: number;
  dvolOpen: number | null;
  dvolHigh: number | null;
  dvolLow: number | null;
  dvolClose: number | null;
  callBuyNotional: number | null;
  callSellNotional: number | null;
  putBuyNotional: number | null;
  putSellNotional: number | null;
  netDelta: number | null;
  netDollarGamma: number | null;
  tradeCount: number | null;
  greekTradeCount: number | null;
  vwIv: number | null;
  putIv25: number | null;
  callIv25: number | null;
}

/**
 * One row per USDT-M funding SETTLEMENT (src/lib/models/funding-settlement.ts),
 * not per bar: `t` is the settlement boundary, `rate` the rate that settled
 * there, `intervalHours` the archive's stated spacing. The snapshot column
 * forward-fills funding onto bars and keeps one rate per bar, which is wrong
 * for anything that must collect each settlement a position crossed (the
 * funding carry test, review 2026-10-01).
 */
export interface FundingRow {
  t: number;
  rate: number;
  intervalHours: number | null;
}

/**
 * One row per 5-minute taker-flow bucket (src/lib/models/archive-flow-bar.ts),
 * folded from the Binance aggTrades archive by scripts/ops/ingest-agg-flow.ts.
 * `t` is the bucket open (bucketStart). A bucket with no row is a gap in the
 * archive, never zero volume. Definitions of the quote and size-class fields
 * are on the model; the *Open10s fields cover [t, t + 10,000 ms).
 */
export interface FlowRow {
  t: number;
  trades: number;
  aggTrades: number;
  buyBase: number;
  sellBase: number;
  buyQuote: number;
  sellQuote: number;
  buyQuoteSmall: number;
  buyQuoteMedium: number;
  buyQuoteLarge: number;
  sellQuoteSmall: number;
  sellQuoteMedium: number;
  sellQuoteLarge: number;
  buyQuoteOpen10s: number;
  sellQuoteOpen10s: number;
  source: string;
}

export type DatasetKind = 'candles' | 'snapshots' | 'htf' | 'perp' | 'metrics' | 'options' | 'funding' | 'flow';

/** The two currencies the options pipeline covers, keyed by their USDT-margined symbol. */
export const OPTIONS_CURRENCY_OF_SYMBOL: Record<string, 'BTC' | 'ETH'> = {
  BTCUSDT: 'BTC',
  ETHUSDT: 'ETH',
};

/** `OPTIONS_CURRENCY_OF_SYMBOL[symbol]`, or null for a symbol Deribit has no options market for. */
export function optionsCurrencyOf(symbol: string): 'BTC' | 'ETH' | null {
  return OPTIONS_CURRENCY_OF_SYMBOL[symbol] ?? null;
}

export interface ManifestFile {
  path: string;
  kind: DatasetKind;
  symbol: string;
  interval: string;
  rowCount: number;
  startMs: number | null;
  endMs: number | null;
  sha256: string;
}

export interface DatasetManifest {
  version: 1;
  generatedAt: string;
  commit: string;
  lockboxStart: string;
  symbols: string[];
  intervals: string[];
  files: ManifestFile[];
  datasetHash: string;
}

/** Data from this instant onward is held out until the final evaluation. */
export const LOCKBOX_START = Date.UTC(2026, 6, 1);
export const LOCKBOX_START_ISO = new Date(LOCKBOX_START).toISOString();

/**
 * Sha256 over every file's own sha256, sorted lexicographically and joined
 * with a newline, so the dataset hash is independent of export order and
 * changes if any single file's content changes.
 */
export function datasetHashOf(files: readonly Pick<ManifestFile, 'sha256'>[]): string {
  const sorted = files.map((f) => f.sha256).sort();
  return createHash('sha256').update(sorted.join('\n')).digest('hex');
}

/**
 * Streams `rows` as newline-delimited JSON through gzip to `path`, creating
 * parent directories as needed.
 */
export async function writeJsonlGz<T>(path: string, rows: readonly T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  const source = Readable.from(
    (function* lines() {
      for (const row of rows) {
        yield JSON.stringify(row) + '\n';
      }
    })()
  );

  await pipeline(source, createGzip(), createWriteStream(path));
}

/**
 * Reads a gzip newline-delimited JSON file back into rows. Synchronous
 * (gunzipSync) is acceptable here: dataset files are read once per load, not
 * streamed incrementally.
 *
 * WARNING: this reads every row in the file, including any at or after the
 * lockbox cutoff (LOCKBOX_START) -- it does not know about the lockbox at
 * all. Research code must not call this directly; use load-dataset.ts's
 * loadCandles/loadSnapshots/loadHtf, which call this and then apply the
 * lockbox (dropped by default, kept only with an explicit allowLockbox).
 */
export function readJsonlGz<T>(path: string): T[] {
  const compressed = readFileSync(path);
  const text = gunzipSync(compressed).toString('utf8');

  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

/** Streaming sha256 of a file's contents. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
