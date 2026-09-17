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

export interface ManifestFile {
  path: string;
  kind: 'candles' | 'snapshots' | 'htf';
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
