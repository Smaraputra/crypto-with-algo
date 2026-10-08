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
 *   klines        both    the twelve-column futures kline row
 *   premiumIndex  both    kline-shaped, close is the perp-to-index premium
 *   markPrice     both    kline-shaped, close is the mark price
 *   fundingRate   monthly calc_time, funding_interval_hours, last_funding_rate
 *   bookDepth     daily   cumulative depth and notional at +/-1..5% of mid,
 *                         about one snapshot every 30 seconds
 *
 * The three kline-shaped datasets are published BOTH ways and `ARCHIVE_CADENCE`
 * records the monthly default, because that is the form bulk history wants: one
 * file per month instead of one per day. The daily form is what a keeper needs,
 * and it is the only one that can be current, because the monthly file for a
 * month does not exist until that month ends. `ArchiveFileSpec.cadence` selects
 * between them; see its doc comment.
 *
 * `bookTicker` is listed as a prefix by the bucket but serves no files for UM
 * futures (404 across 2022 to 2025, daily and monthly, checked 2026-09-20), so
 * order-book work goes through `bookDepth`.
 *
 * `aggTrades` is supported only through `streamArchiveCsvLines`: one monthly
 * file is about 0.7 GB compressed and several GB inflated, past what
 * `fetchArchiveFile` can hold as a string, so it is never buffered whole.
 */
import { createHash } from 'node:crypto';
import { createInflateRaw, crc32 as zlibCrc32, inflateRawSync } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
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
  | 'bookDepth'
  | 'aggTrades';

/** Daily datasets are keyed by 'YYYY-MM-DD', monthly ones by 'YYYY-MM'. */
export const ARCHIVE_CADENCE: Record<ArchiveDataset, 'daily' | 'monthly'> = {
  metrics: 'daily',
  bookDepth: 'daily',
  klines: 'monthly',
  premiumIndex: 'monthly',
  markPrice: 'monthly',
  fundingRate: 'monthly',
  aggTrades: 'monthly',
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
  aggTrades: 'aggTrades',
};

export type ArchiveCadence = 'daily' | 'monthly';

export interface ArchiveFileSpec {
  dataset: ArchiveDataset;
  symbol: string;
  /** Required for klines, premiumIndex and markPrice; rejected for the rest. */
  interval?: string;
  /** 'YYYY-MM-DD' when the cadence is daily, 'YYYY-MM' when it is monthly. */
  date: string;
  /**
   * Override the dataset's default cadence, for the datasets Binance publishes
   * BOTH ways.
   *
   * The kline-shaped datasets are monthly in `ARCHIVE_CADENCE` because that is
   * the form bulk history wants: one file per month instead of one per day.
   * But the monthly form of the CURRENT month does not exist until the month
   * ends, so anything reading through the monthly path is up to a month
   * behind. The daily form is published a day after each day ends, so a keeper
   * that wants to stay a day behind asks for it explicitly.
   *
   * Only the file's DATE SHAPE and its `/daily/` vs `/monthly/` path segment
   * depend on this; the file name and the cache key carry the date, so a daily
   * and a monthly request for the same dataset can never collide.
   */
  cadence?: ArchiveCadence;
}

/** The cadence a spec resolves to: its own override, else the dataset's. */
function cadenceOf(spec: ArchiveFileSpec): ArchiveCadence {
  const cadence = spec.cadence ?? ARCHIVE_CADENCE[spec.dataset];
  if (!cadence) throw new Error(`Unknown archive dataset: ${spec.dataset}`);
  return cadence;
}

const DAILY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHLY_DATE = /^\d{4}-\d{2}$/;

function assertSpec(spec: ArchiveFileSpec): void {
  const cadence = cadenceOf(spec);

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
  const segments = [
    'data',
    'futures',
    'um',
    cadenceOf(spec),
    PATH_SEGMENT[spec.dataset],
    spec.symbol,
    ...(spec.interval ? [spec.interval] : []),
    archiveFileName(spec),
  ];
  return `${getBaseUrl()}/${segments.join('/')}`;
}

/**
 * Cache path: <cacheDir>/<dataset>/<symbol>/[<interval>/]<file>.zip
 *
 * The date is part of the file name, so a daily `2026-09-19` and a monthly
 * `2026-09` request for the same dataset and symbol are already different
 * cache files. The cadence itself is not in the path because the date shape
 * distinguishes them, and adding it would invalidate every cached file.
 */
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
  /**
   * Treat a zero-length cache file (a remembered 404) as a cache miss and ask the
   * archive again, and do not write a new negative-cache file on a 404. For callers
   * that list files from a bucket listing: a file the listing names must exist, so
   * a remembered 404 for it is stale.
   */
  ignoreNegativeCache?: boolean;
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
      if (cached.length > 0) return readSingleZipEntry(cached).data.toString('utf8');
      if (!options.ignoreNegativeCache) return null;
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
        if (cachePath && !options.ignoreNegativeCache) {
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

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Idle limit while streaming: a body that delivers nothing for this long is dead. */
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP64_EXTRA_ID = 0x0001;
const MAX_UINT32 = 0xffffffff;
/** Signature + crc + two 8-byte sizes. */
const MAX_DESCRIPTOR_BYTES = 24;
const LOCAL_FIXED_BYTES = 30;

/** The zip's own integrity data disagrees with the bytes read. Never retried. */
export class ArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveIntegrityError';
  }
}

export type StreamArchiveResult =
  | { status: 'missing' }
  | { status: 'ok'; lines: number; uncompressedBytes: number };

export interface StreamArchiveOptions {
  /** Base backoff in ms. Tests pass 0; nothing in production should set it. */
  retryBaseMs?: number;
  /** Idle timeout in ms. */
  idleTimeoutMs?: number;
  /**
   * Called before a retry that follows a failure AFTER lines were already delivered.
   * Without it such a failure is thrown, because a restart would repeat lines.
   */
  onRestart?: () => void;
}

interface LocalHeader {
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  zip64: boolean;
  dataStart: number;
}

/** The local file header at the start of `buf`, or null while more bytes are needed. */
function parseLocalHeader(buf: Buffer): LocalHeader | null {
  if (buf.length < LOCAL_FIXED_BYTES) return null;
  if (buf.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ArchiveIntegrityError('Corrupt zip: local file header signature not found');
  }
  const nameLength = buf.readUInt16LE(26);
  const extraLength = buf.readUInt16LE(28);
  const dataStart = LOCAL_FIXED_BYTES + nameLength + extraLength;
  if (buf.length < dataStart) return null;

  let compressedSize = buf.readUInt32LE(18);
  let uncompressedSize = buf.readUInt32LE(22);
  let zip64 = false;
  let at = LOCAL_FIXED_BYTES + nameLength;
  while (at + 4 <= dataStart) {
    const id = buf.readUInt16LE(at);
    const size = buf.readUInt16LE(at + 2);
    if (id === ZIP64_EXTRA_ID) {
      zip64 = true;
      let field = at + 4;
      if (uncompressedSize === MAX_UINT32 && field + 8 <= at + 4 + size) {
        uncompressedSize = Number(buf.readBigUInt64LE(field));
        field += 8;
      }
      if (compressedSize === MAX_UINT32 && field + 8 <= at + 4 + size) {
        compressedSize = Number(buf.readBigUInt64LE(field));
      }
    }
    at += 4 + size;
  }

  return {
    flags: buf.readUInt16LE(6),
    method: buf.readUInt16LE(8),
    crc: buf.readUInt32LE(14),
    compressedSize,
    uncompressedSize,
    zip64,
    dataStart,
  };
}

/** Whether the counted size equals a stored one, allowing a 4-byte field that wrapped. */
function sizeMatches(expected: number, counted: number, width: 4 | 8): boolean {
  return width === 8 ? expected === counted : expected === counted % 2 ** 32;
}

/**
 * Checks the entry's crc and size against the data descriptor in `trailer`.
 * The descriptor has an optional signature and 4 or 8 byte sizes, so every
 * layout is tried and one must agree on the crc and the uncompressed size.
 */
function descriptorMatches(trailer: Buffer, crc: number, bytes: number): boolean {
  for (const signed of [true, false]) {
    if (signed && (trailer.length < 4 || trailer.readUInt32LE(0) !== DESCRIPTOR_SIGNATURE)) continue;
    const base = signed ? 4 : 0;
    for (const width of [4, 8] as const) {
      if (trailer.length < base + 4 + 2 * width) continue;
      if (trailer.readUInt32LE(base) !== crc) continue;
      const uncompressed =
        width === 8 ? Number(trailer.readBigUInt64LE(base + 4 + width)) : trailer.readUInt32LE(base + 4 + width);
      if (sizeMatches(uncompressed, bytes, width)) return true;
    }
  }
  return false;
}

function verifyIntegrity(header: LocalHeader, trailer: Buffer, crc: number, bytes: number, label: string): void {
  if (header.flags & FLAG_DATA_DESCRIPTOR) {
    if (!descriptorMatches(trailer, crc, bytes)) {
      throw new ArchiveIntegrityError(
        `${label}: crc32/size disagree with the data descriptor (computed crc ${crc.toString(16)}, ${bytes} bytes)`
      );
    }
    return;
  }
  if (header.crc !== crc) {
    throw new ArchiveIntegrityError(
      `${label}: crc32 mismatch, header ${header.crc.toString(16)}, computed ${crc.toString(16)}`
    );
  }
  if (!sizeMatches(header.uncompressedSize, bytes, header.zip64 ? 8 : 4)) {
    throw new ArchiveIntegrityError(
      `${label}: expected ${header.uncompressedSize} bytes, inflated ${bytes}`
    );
  }
}

type LineHandler = (line: string) => void | Promise<void>;

/** One attempt: stream `body`, inflate it, hand lines to `onLine`. Verified before it returns. */
async function streamZipBody(
  body: ReadableStream<Uint8Array>,
  onLine: LineHandler,
  label: string,
  idle: { arm: () => void; pause: () => void },
  progress: { delivered: boolean }
): Promise<{ lines: number; uncompressedBytes: number }> {
  const reader = body.getReader();
  let header: LocalHeader | null = null;
  let headerBuf: Buffer = Buffer.alloc(0);
  let inflate: ReturnType<typeof createInflateRaw> | null = null;
  let consumerP: Promise<void> | null = null;
  let fed = 0;
  let inflateEnded = false;
  let trailer: Buffer = Buffer.alloc(0);

  let crc = 0;
  let bytes = 0;
  let lines = 0;

  const emit = async (raw: string): Promise<void> => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') return;
    lines++;
    progress.delivered = true;
    const result = onLine(line);
    if (result) await result;
  };

  const startInflate = (): void => {
    const stream = createInflateRaw();
    inflate = stream;
    const decoder = new StringDecoder('utf8');
    consumerP = (async () => {
      let carry = '';
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        crc = zlibCrc32(chunk, crc);
        bytes += chunk.length;
        const parts = (carry + decoder.write(chunk)).split('\n');
        carry = parts.pop() ?? '';
        for (const part of parts) await emit(part);
      }
      carry += decoder.end();
      if (carry !== '') await emit(carry);
    })();
    consumerP.catch(() => undefined);
  };

  const write = (chunk: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      (inflate as NonNullable<typeof inflate>).write(chunk, (error) => (error ? reject(error) : resolve()));
    });

  /** Feed compressed bytes; returns the bytes left over after the deflate stream's end. */
  const feed = async (chunk: Buffer): Promise<Buffer | null> => {
    const known = !(header!.flags & FLAG_DATA_DESCRIPTOR);
    let usable = chunk;
    if (known) {
      const remaining = header!.compressedSize - fed;
      if (chunk.length > remaining) usable = chunk.subarray(0, remaining);
    }
    await write(usable);
    fed += usable.length;
    const consumed = (inflate as NonNullable<typeof inflate>).bytesWritten;
    // zlib counts consumed input: fewer than fed means the deflate stream ended inside this chunk.
    if (consumed < fed) {
      const leftover = fed - consumed;
      fed = consumed;
      inflateEnded = true;
      return Buffer.concat([usable.subarray(usable.length - leftover), chunk.subarray(usable.length)]);
    }
    if (known && fed >= header!.compressedSize) {
      inflateEnded = true;
      return chunk.subarray(usable.length);
    }
    return null;
  };

  try {
    for (;;) {
      // The idle timer covers the network read only. It is paused while the consumer works, so a
      // slow consumer (a database write, say) is never mistaken for a dead connection.
      idle.arm();
      const { done, value } = await reader.read();
      idle.pause();
      if (done) break;
      let chunk: Buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);

      if (!header) {
        headerBuf = headerBuf.length ? Buffer.concat([headerBuf, chunk]) : chunk;
        header = parseLocalHeader(headerBuf);
        if (!header) continue;
        if (header.method !== METHOD_DEFLATE) {
          throw new ArchiveIntegrityError(`${label}: unsupported zip compression method ${header.method}`);
        }
        chunk = headerBuf.subarray(header.dataStart);
        startInflate();
        if (chunk.length === 0) continue;
      }

      if (!inflateEnded) {
        const leftover = await feed(chunk);
        if (leftover) trailer = leftover;
      } else {
        trailer = Buffer.concat([trailer, chunk]);
      }

      if (inflateEnded && (trailer.length >= MAX_DESCRIPTOR_BYTES || !(header.flags & FLAG_DATA_DESCRIPTOR))) {
        await reader.cancel();
        break;
      }
    }

    if (!header || !inflate || !consumerP) {
      throw new ArchiveIntegrityError(`${label}: stream ended before a zip local header was complete`);
    }
    (inflate as ReturnType<typeof createInflateRaw>).end();
    await consumerP;
  } catch (error) {
    if (inflate) (inflate as ReturnType<typeof createInflateRaw>).destroy();
    // A consumer failure (a throwing onLine, bad deflate data) is the root cause of a failed write.
    if (consumerP) await consumerP;
    reader.cancel().catch(() => undefined);
    throw error;
  }

  verifyIntegrity(header, trailer, crc, bytes, label);
  return { lines, uncompressedBytes: bytes };
}

/**
 * Streams one archive file's CSV lines to `onLine` without ever holding the
 * file: the HTTP body is read in chunks, the zip local header is parsed, the
 * deflate data goes through `createInflateRaw`, and the output is split into
 * lines (a `\r` is stripped, blank lines skipped, the header row passed on).
 * Memory stays bounded because the next chunk is not read until the consumer
 * has taken the previous one, and an async `onLine` is awaited.
 *
 * Integrity: the crc32 and size of what was inflated are checked against the
 * local header, or against the data descriptor when general purpose bit 3 is
 * set. A mismatch throws `ArchiveIntegrityError` and is not retried.
 *
 * A 404 resolves to `{ status: 'missing' }`. A 5xx or a network error retries
 * with backoff. A failure after lines were delivered retries only when the
 * caller supplied `onRestart` (to discard what it had folded), else it throws.
 */
export async function streamArchiveCsvLines(
  spec: ArchiveFileSpec,
  onLine: LineHandler,
  options: StreamArchiveOptions = {}
): Promise<StreamArchiveResult> {
  const url = archiveUrl(spec);
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
  const idleMs = options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && retryBaseMs > 0) await sleep(retryBaseMs * 2 ** (attempt - 1));

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pause = (): void => clearTimeout(timer);
    const arm = (): void => {
      pause();
      timer = setTimeout(() => controller.abort(), idleMs);
    };
    const progress = { delivered: false };

    try {
      arm();
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) {
        await res.body?.cancel();
        return { status: 'missing' };
      }
      if (!res.ok && res.status < 500) {
        throw new Error(`Archive fetch failed: HTTP ${res.status} for ${url}`);
      }
      if (!res.ok) {
        await res.body?.cancel();
        lastError = new Error(`Archive fetch failed: HTTP ${res.status} for ${url}`);
        continue;
      }
      if (!res.body) throw new Error(`Archive fetch returned no body for ${url}`);

      const result = await streamZipBody(res.body, onLine, archiveFileName(spec), { arm, pause }, progress);
      return { status: 'ok', ...result };
    } catch (error) {
      if (error instanceof ArchiveIntegrityError) throw error;
      if (error instanceof Error && error.message.startsWith('Archive fetch failed: HTTP 4')) throw error;
      if (progress.delivered) {
        if (!options.onRestart) throw error;
        options.onRestart();
      }
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Archive stream failed after ${MAX_ATTEMPTS} attempts for ${url}`);
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
