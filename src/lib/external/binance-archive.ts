/**
 * Binance public data archive client (https://data.binance.vision).
 *
 * The archive is the only source of multi-year USDT-M perpetual history that
 * this project can reach. The REST endpoints in `src/lib/binance-futures.ts`
 * serve `futures/data/*` for roughly the last 30 days (see RECENT_FUTURES_LIMIT
 * in `src/lib/snapshot-backfill.ts`), which is why stored open interest and
 * long/short ratio cover 11% of 1h bars and nothing before 2026-03-03. The
 * archive carries the same series at 5m resolution back to 2021.
 *
 * It is also reachable where the REST host is not: the home ISP blocks
 * `fapi.binance.com` without a VPN, while the archive is plain S3.
 *
 * Datasets used here, with the shapes verified against live files on
 * 2026-09-20:
 *
 *   metrics       daily   open interest, top-trader and global long/short,
 *                         taker long/short volume ratio, one row per 5m
 *   klines        monthly the twelve-column futures kline row
 *   premiumIndex  monthly kline-shaped, close is the perp-to-index premium
 *   markPrice     monthly kline-shaped, close is the mark price
 *   fundingRate   monthly calc_time, funding_interval_hours, last_funding_rate
 *   bookDepth     daily   cumulative depth and notional at +/-1..5% of mid,
 *                         about one snapshot every 30 seconds
 *
 * `bookTicker` is listed as a prefix by the bucket but serves no files for UM
 * futures (404 across 2022 to 2025, daily and monthly, checked 2026-09-20), so
 * order-book work goes through `bookDepth`. `aggTrades` is deliberately not
 * supported: it is about 408 MB per symbol-month, and the taker imbalance it
 * would provide is already carried by the kline row's taker_buy_volume.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEFAULT_ARCHIVE_URL = 'https://data.binance.vision';

/** Mirrors the BINANCE_API_URL escape hatch: read at call time, never cached. */
function getBaseUrl(): string {
  return process.env.BINANCE_ARCHIVE_URL || DEFAULT_ARCHIVE_URL;
}

export type ArchiveDataset =
  | 'metrics'
  | 'klines'
  | 'premiumIndex'
  | 'markPrice'
  | 'fundingRate'
  | 'bookDepth';

/** Daily datasets are keyed by 'YYYY-MM-DD', monthly ones by 'YYYY-MM'. */
export const ARCHIVE_CADENCE: Record<ArchiveDataset, 'daily' | 'monthly'> = {
  metrics: 'daily',
  bookDepth: 'daily',
  klines: 'monthly',
  premiumIndex: 'monthly',
  markPrice: 'monthly',
  fundingRate: 'monthly',
};

/** Datasets whose path carries an interval segment. */
const INTERVAL_DATASETS = new Set<ArchiveDataset>(['klines', 'premiumIndex', 'markPrice']);

/** The path segment Binance uses, where it differs from our dataset name. */
const PATH_SEGMENT: Record<ArchiveDataset, string> = {
  metrics: 'metrics',
  klines: 'klines',
  premiumIndex: 'premiumIndexKlines',
  markPrice: 'markPriceKlines',
  fundingRate: 'fundingRate',
  bookDepth: 'bookDepth',
};

export interface ArchiveFileSpec {
  dataset: ArchiveDataset;
  symbol: string;
  /** Required for klines, premiumIndex and markPrice; rejected for the rest. */
  interval?: string;
  /** 'YYYY-MM-DD' for daily datasets, 'YYYY-MM' for monthly ones. */
  date: string;
}

const DAILY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHLY_DATE = /^\d{4}-\d{2}$/;

function assertSpec(spec: ArchiveFileSpec): void {
  const cadence = ARCHIVE_CADENCE[spec.dataset];
  if (!cadence) throw new Error(`Unknown archive dataset: ${spec.dataset}`);

  const pattern = cadence === 'daily' ? DAILY_DATE : MONTHLY_DATE;
  if (!pattern.test(spec.date)) {
    throw new Error(
      `${spec.dataset} is a ${cadence} dataset and needs a ` +
        `${cadence === 'daily' ? 'YYYY-MM-DD' : 'YYYY-MM'} date, got "${spec.date}"`
    );
  }

  const needsInterval = INTERVAL_DATASETS.has(spec.dataset);
  if (needsInterval && !spec.interval) {
    throw new Error(`${spec.dataset} needs an interval`);
  }
  if (!needsInterval && spec.interval) {
    throw new Error(`${spec.dataset} takes no interval, got "${spec.interval}"`);
  }
}

/** The file name Binance gives the zip, which is also the cache key. */
export function archiveFileName(spec: ArchiveFileSpec): string {
  assertSpec(spec);
  const middle = spec.interval ? spec.interval : PATH_SEGMENT[spec.dataset];
  return `${spec.symbol}-${middle}-${spec.date}.zip`;
}

export function archiveUrl(spec: ArchiveFileSpec): string {
  assertSpec(spec);
  const cadence = ARCHIVE_CADENCE[spec.dataset];
  const segments = [
    'data',
    'futures',
    'um',
    cadence,
    PATH_SEGMENT[spec.dataset],
    spec.symbol,
    ...(spec.interval ? [spec.interval] : []),
    archiveFileName(spec),
  ];
  return `${getBaseUrl()}/${segments.join('/')}`;
}

/** Cache path: <cacheDir>/<dataset>/<symbol>/[<interval>/]<file>.zip */
export function archiveCachePath(cacheDir: string, spec: ArchiveFileSpec): string {
  assertSpec(spec);
  return join(
    cacheDir,
    spec.dataset,
    spec.symbol,
    ...(spec.interval ? [spec.interval] : []),
    archiveFileName(spec)
  );
}

// ---------------------------------------------------------------------------
// Zip reading
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end-of-central-directory record plus the largest possible zip comment. */
const MAX_EOCD_SCAN = 22 + 0xffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * The single entry of a Binance archive zip.
 *
 * Every archive file holds exactly one CSV, stored or deflated, well under the
 * 4 GB zip64 boundary. Sizes and offsets are read from the central directory
 * rather than the local header, because an entry written with a data descriptor
 * (general purpose bit 3) carries zeroes in the local header, and only the
 * central directory is authoritative in that case.
 */
export function readSingleZipEntry(buf: Buffer): { name: string; data: Buffer } {
  const scanFrom = Math.max(0, buf.length - MAX_EOCD_SCAN);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive: no end-of-central-directory record');

  const entryCount = buf.readUInt16LE(eocd + 10);
  if (entryCount !== 1) {
    throw new Error(`Expected exactly one zip entry, found ${entryCount}`);
  }

  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(centralOffset) !== CENTRAL_SIGNATURE) {
    throw new Error('Corrupt zip: central directory header not found at its stated offset');
  }

  const method = buf.readUInt16LE(centralOffset + 10);
  const compressedSize = buf.readUInt32LE(centralOffset + 20);
  const uncompressedSize = buf.readUInt32LE(centralOffset + 24);
  const nameLength = buf.readUInt16LE(centralOffset + 28);
  const localOffset = buf.readUInt32LE(centralOffset + 42);
  const name = buf.toString('utf8', centralOffset + 46, centralOffset + 46 + nameLength);

  if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new Error('Corrupt zip: local file header not found at its stated offset');
  }
  const localNameLength = buf.readUInt16LE(localOffset + 26);
  const localExtraLength = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const compressed = buf.subarray(dataStart, dataStart + compressedSize);

  let data: Buffer;
  if (method === METHOD_STORED) {
    data = Buffer.from(compressed);
  } else if (method === METHOD_DEFLATE) {
    data = inflateRawSync(compressed);
  } else {
    throw new Error(`Unsupported zip compression method ${method}`);
  }

  if (data.length !== uncompressedSize) {
    throw new Error(`Zip entry ${name}: expected ${uncompressedSize} bytes, inflated ${data.length}`);
  }

  return { name, data };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchArchiveOptions {
  /** Directory for downloaded zips. Omit to bypass the cache entirely. */
  cacheDir?: string;
  /** Re-download even when the zip is already cached. */
  refresh?: boolean;
  /** Base backoff in ms. Tests pass 0; nothing in production should set it. */
  retryBaseMs?: number;
}

/**
 * The decompressed CSV for one archive file, or null when the file does not
 * exist. A 404 is ordinary: every symbol has a first day, and daily files stop
 * one or two days short of now.
 */
export async function fetchArchiveFile(
  spec: ArchiveFileSpec,
  options: FetchArchiveOptions = {}
): Promise<string | null> {
  const cachePath = options.cacheDir ? archiveCachePath(options.cacheDir, spec) : null;

  if (cachePath && !options.refresh) {
    const cached = await readFile(cachePath).catch(() => null);
    if (cached) {
      // A zero-length cache file is how a known 404 is remembered.
      if (cached.length === 0) return null;
      return readSingleZipEntry(cached).data.toString('utf8');
    }
  }

  const url = archiveUrl(spec);
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && retryBaseMs > 0) await sleep(retryBaseMs * 2 ** (attempt - 1));

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

      if (res.status === 404) {
        if (cachePath) {
          await mkdir(dirname(cachePath), { recursive: true });
          await writeFile(cachePath, Buffer.alloc(0));
        }
        return null;
      }
      // 4xx other than 404 is a bad request, not a blip: do not retry it.
      if (!res.ok && res.status < 500) {
        throw new Error(`Archive fetch failed: HTTP ${res.status} for ${url}`);
      }
      if (!res.ok) {
        lastError = new Error(`Archive fetch failed: HTTP ${res.status} for ${url}`);
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      const entry = readSingleZipEntry(buf);

      if (cachePath) {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, buf);
      }
      return entry.data.toString('utf8');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Archive fetch failed: HTTP 4')) {
        throw error;
      }
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Archive fetch failed after ${MAX_ATTEMPTS} attempts for ${url}`);
}

/** sha256 of a decompressed CSV, for recording what an ingest actually read. */
export function csvHash(csv: string): string {
  return createHash('sha256').update(csv).digest('hex');
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Whether the first line of an archive CSV is a header.
 *
 * It cannot be assumed either way: kline files written before about 2024 have
 * no header row (BTCUSDT-5m-2021-11 starts straight at 1635724800000) while
 * later ones do, and metrics, fundingRate and bookDepth have carried one since
 * 2021. A header is recognised by its first field parsing as neither a number
 * nor a timestamp, which holds for every column name Binance uses.
 */
export function looksLikeHeader(line: string): boolean {
  const first = line.split(',')[0]?.trim() ?? '';
  if (first === '') return false;
  if (Number.isFinite(Number(first))) return false;
  return !Number.isFinite(parseArchiveTimestamp(first));
}

/**
 * Archive timestamps come in two shapes: epoch milliseconds on the kline and
 * funding files, and 'YYYY-MM-DD HH:MM:SS' in UTC on metrics and bookDepth.
 * Returns NaN for anything else, so a malformed row is dropped rather than
 * silently landing at the epoch.
 */
export function parseArchiveTimestamp(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '') return Number.NaN;

  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    // Some funding rows carry microsecond-ish precision (calc_time 1635724800009);
    // anything with more than 13 digits is not milliseconds.
    return trimmed.length <= 13 ? ms : Number.NaN;
  }

  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(trimmed);
  if (iso) return Date.parse(`${iso[1]}T${iso[2]}Z`);

  return Number.NaN;
}

/** A field that must be a real number; null when absent or unparseable. */
function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Non-empty lines of a CSV with the header dropped when there is one. */
function dataLines(csv: string): string[] {
  const lines = csv.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (out.length === 0 && i === 0 && looksLikeHeader(line)) continue;
    // A header can also follow a leading blank line.
    if (out.length === 0 && looksLikeHeader(line)) continue;
    out.push(line);
  }
  return out;
}

export interface MetricsCsvRow {
  timestamp: number;
  openInterest: number | null;
  openInterestValue: number | null;
  topTraderAccountRatio: number | null;
  topTraderPositionRatio: number | null;
  globalAccountRatio: number | null;
  takerLongShortRatio: number | null;
}

/**
 * create_time, symbol, sum_open_interest, sum_open_interest_value,
 * count_toptrader_long_short_ratio, sum_toptrader_long_short_ratio,
 * count_long_short_ratio, sum_taker_long_short_vol_ratio
 *
 * The two top-trader columns differ: `count_` is the ratio of long to short
 * accounts, `sum_` the ratio of their position values. `count_long_short_ratio`
 * is the global account ratio, the same series the REST
 * globalLongShortAccountRatio endpoint serves for the last 30 days.
 */
export function parseMetricsCsv(csv: string): MetricsCsvRow[] {
  const rows: MetricsCsvRow[] = [];
  for (const line of dataLines(csv)) {
    const f = line.split(',');
    const timestamp = parseArchiveTimestamp(f[0] ?? '');
    if (!Number.isFinite(timestamp)) continue;
    rows.push({
      timestamp,
      openInterest: num(f[2]),
      openInterestValue: num(f[3]),
      topTraderAccountRatio: num(f[4]),
      topTraderPositionRatio: num(f[5]),
      globalAccountRatio: num(f[6]),
      takerLongShortRatio: num(f[7]),
    });
  }
  return rows;
}

export interface KlineCsvRow {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades: number;
  takerBuyVolume: number | null;
}

/**
 * open_time, open, high, low, close, volume, close_time, quote_volume, count,
 * taker_buy_volume, taker_buy_quote_volume, ignore
 *
 * Shared by klines, premiumIndexKlines and markPriceKlines. On the latter two
 * volume and taker volume are always 0 and `close` carries the premium or the
 * mark price; only OHLC is meaningful there.
 *
 * A row whose OHLC is not fully finite is dropped rather than repaired: a
 * partial bar in a study is worse than a missing one.
 */
export function parseKlineCsv(csv: string): KlineCsvRow[] {
  const rows: KlineCsvRow[] = [];
  for (const line of dataLines(csv)) {
    const f = line.split(',');
    const timestamp = parseArchiveTimestamp(f[0] ?? '');
    const open = num(f[1]);
    const high = num(f[2]);
    const low = num(f[3]);
    const close = num(f[4]);
    if (!Number.isFinite(timestamp)) continue;
    if (open === null || high === null || low === null || close === null) continue;
    rows.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume: num(f[5]) ?? 0,
      quoteVolume: num(f[7]) ?? 0,
      trades: num(f[8]) ?? 0,
      takerBuyVolume: num(f[9]),
    });
  }
  return rows;
}

export interface FundingCsvRow {
  timestamp: number;
  intervalHours: number | null;
  rate: number;
}

/**
 * calc_time, funding_interval_hours, last_funding_rate
 *
 * Note this is not the REST `/fapi/v1/fundingRate` shape, which returns
 * fundingTime, fundingRate and markPrice. There is no mark price here; the
 * mark price series is a separate markPriceKlines dataset.
 */
export function parseFundingCsv(csv: string): FundingCsvRow[] {
  const rows: FundingCsvRow[] = [];
  for (const line of dataLines(csv)) {
    const f = line.split(',');
    const timestamp = parseArchiveTimestamp(f[0] ?? '');
    const rate = num(f[2]);
    if (!Number.isFinite(timestamp) || rate === null) continue;
    rows.push({ timestamp, intervalHours: num(f[1]), rate });
  }
  return rows;
}

export interface BookDepthSnapshot {
  timestamp: number;
  /** Cumulative notional at each signed percentage level, e.g. -1 or 5. */
  notional: Map<number, number>;
  /** Cumulative base-asset depth at the same levels. */
  depth: Map<number, number>;
}

/**
 * timestamp, percentage, depth, notional
 *
 * One row per level per snapshot, ten levels (-5..-1, 1..5) about every 30
 * seconds. Negative percentages are below mid (the bid side), positive above
 * (the ask side), and both are cumulative outward from mid: the -5 figure
 * includes everything inside it.
 *
 * Rows are grouped back into one snapshot per timestamp, in first-seen order.
 * A snapshot missing levels is kept as it is; the caller decides whether the
 * levels it needs are present.
 */
export function parseBookDepthCsv(csv: string): BookDepthSnapshot[] {
  const byTime = new Map<number, BookDepthSnapshot>();
  for (const line of dataLines(csv)) {
    const f = line.split(',');
    const timestamp = parseArchiveTimestamp(f[0] ?? '');
    const percentage = num(f[1]);
    const depth = num(f[2]);
    const notional = num(f[3]);
    if (!Number.isFinite(timestamp) || percentage === null) continue;

    let snapshot = byTime.get(timestamp);
    if (!snapshot) {
      snapshot = { timestamp, notional: new Map(), depth: new Map() };
      byTime.set(timestamp, snapshot);
    }
    if (notional !== null) snapshot.notional.set(percentage, notional);
    if (depth !== null) snapshot.depth.set(percentage, depth);
  }
  return Array.from(byTime.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Book-side imbalance at one percentage band, in [-1, 1], positive when the bid
 * side carries more notional. Null when either side is missing, so a gap never
 * reads as balanced.
 */
export function depthImbalance(snapshot: BookDepthSnapshot, pct: number): number | null {
  const bid = snapshot.notional.get(-Math.abs(pct));
  const ask = snapshot.notional.get(Math.abs(pct));
  if (bid === undefined || ask === undefined) return null;
  const total = bid + ask;
  if (!Number.isFinite(total) || total <= 0) return null;
  return (bid - ask) / total;
}
