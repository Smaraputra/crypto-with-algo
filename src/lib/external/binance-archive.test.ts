// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARCHIVE_CADENCE,
  archiveCachePath,
  archiveFileName,
  archiveUrl,
  csvHash,
  depthImbalance,
  fetchArchiveFile,
  looksLikeHeader,
  parseArchiveTimestamp,
  parseBookDepthCsv,
  parseFundingCsv,
  parseKlineCsv,
  parseMetricsCsv,
  readSingleZipEntry,
} from './binance-archive';

// ---------------------------------------------------------------------------
// Zip fixtures: built here rather than embedded as base64 so the reader is
// exercised against bytes whose layout the test controls.
// ---------------------------------------------------------------------------

function buildZip(
  name: string,
  contents: string,
  opts: { method?: 0 | 8; entryCount?: number; zeroLocalSizes?: boolean } = {}
): Buffer {
  const method = opts.method ?? 8;
  const raw = Buffer.from(contents, 'utf8');
  const body = method === 8 ? deflateRawSync(raw) : raw;
  const nameBuf = Buffer.from(name, 'utf8');
  // crc32 is not validated by the reader, so a constant is fine here.
  const crc = 0x12345678;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  // Bit 3 set means the local sizes are zero and only the central directory
  // is authoritative, which is the case this reader must survive.
  local.writeUInt16LE(opts.zeroLocalSizes ? 0x0008 : 0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(opts.zeroLocalSizes ? 0 : body.length, 18);
  local.writeUInt32LE(opts.zeroLocalSizes ? 0 : raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const localOffset = 0;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(opts.zeroLocalSizes ? 0x0008 : 0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(localOffset, 42);

  const centralStart = local.length + nameBuf.length + body.length;
  const centralSize = central.length + nameBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.entryCount ?? 1, 8);
  eocd.writeUInt16LE(opts.entryCount ?? 1, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([local, nameBuf, body, central, nameBuf, eocd]);
}

describe('readSingleZipEntry', () => {
  it('inflates a deflated entry', () => {
    const zip = buildZip('a.csv', 'one,two\n1,2\n');
    const entry = readSingleZipEntry(zip);
    expect(entry.name).toBe('a.csv');
    expect(entry.data.toString('utf8')).toBe('one,two\n1,2\n');
  });

  it('reads a stored entry', () => {
    const zip = buildZip('b.csv', 'stored contents', { method: 0 });
    expect(readSingleZipEntry(zip).data.toString('utf8')).toBe('stored contents');
  });

  it('uses the central directory when the local header carries zero sizes', () => {
    // A data-descriptor entry: the local header lies, the central one does not.
    const zip = buildZip('c.csv', 'x'.repeat(5000), { zeroLocalSizes: true });
    expect(readSingleZipEntry(zip).data.toString('utf8')).toBe('x'.repeat(5000));
  });

  it('survives a payload large enough to matter', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `${i},${i * 2}`).join('\n');
    expect(readSingleZipEntry(buildZip('d.csv', big)).data.toString('utf8')).toBe(big);
  });

  it('rejects a buffer with no end-of-central-directory record', () => {
    expect(() => readSingleZipEntry(Buffer.alloc(100))).toThrow(/no end-of-central-directory/);
  });

  it('rejects a multi-entry archive rather than guessing which entry to read', () => {
    expect(() => readSingleZipEntry(buildZip('e.csv', 'x', { entryCount: 2 }))).toThrow(
      /Expected exactly one zip entry, found 2/
    );
  });
});

describe('archiveUrl and friends', () => {
  it('builds a daily metrics url', () => {
    expect(archiveUrl({ dataset: 'metrics', symbol: 'BTCUSDT', date: '2025-06-01' })).toBe(
      'https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2025-06-01.zip'
    );
  });

  it('builds a monthly kline url with the interval segment', () => {
    expect(
      archiveUrl({ dataset: 'klines', symbol: 'ETHUSDT', interval: '1h', date: '2024-03' })
    ).toBe(
      'https://data.binance.vision/data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2024-03.zip'
    );
  });

  it('maps premiumIndex and markPrice onto their Binance path segments', () => {
    expect(
      archiveUrl({ dataset: 'premiumIndex', symbol: 'BTCUSDT', interval: '5m', date: '2025-06' })
    ).toContain('/premiumIndexKlines/BTCUSDT/5m/BTCUSDT-5m-2025-06.zip');
    expect(
      archiveUrl({ dataset: 'markPrice', symbol: 'BTCUSDT', interval: '5m', date: '2025-06' })
    ).toContain('/markPriceKlines/BTCUSDT/5m/BTCUSDT-5m-2025-06.zip');
  });

  it('honours BINANCE_ARCHIVE_URL at call time', () => {
    const previous = process.env.BINANCE_ARCHIVE_URL;
    process.env.BINANCE_ARCHIVE_URL = 'http://localhost:9000';
    try {
      expect(
        archiveUrl({ dataset: 'metrics', symbol: 'BTCUSDT', date: '2025-06-01' }).startsWith(
          'http://localhost:9000/'
        )
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BINANCE_ARCHIVE_URL;
      else process.env.BINANCE_ARCHIVE_URL = previous;
    }
  });

  it('rejects a date whose shape does not match the dataset cadence', () => {
    expect(() => archiveUrl({ dataset: 'metrics', symbol: 'BTCUSDT', date: '2025-06' })).toThrow(
      /daily dataset and needs a YYYY-MM-DD date/
    );
    expect(() =>
      archiveUrl({ dataset: 'klines', symbol: 'BTCUSDT', interval: '5m', date: '2025-06-01' })
    ).toThrow(/monthly dataset and needs a YYYY-MM date/);
  });

  it('requires an interval only where the path has one', () => {
    expect(() => archiveUrl({ dataset: 'klines', symbol: 'BTCUSDT', date: '2025-06' })).toThrow(
      /needs an interval/
    );
    expect(() =>
      archiveUrl({ dataset: 'metrics', symbol: 'BTCUSDT', interval: '5m', date: '2025-06-01' })
    ).toThrow(/takes no interval/);
  });

  it('agrees with itself on cadence', () => {
    expect(ARCHIVE_CADENCE.metrics).toBe('daily');
    expect(ARCHIVE_CADENCE.bookDepth).toBe('daily');
    expect(ARCHIVE_CADENCE.klines).toBe('monthly');
    expect(ARCHIVE_CADENCE.fundingRate).toBe('monthly');
  });

  it('names cache paths by dataset, symbol and interval', () => {
    expect(
      archiveCachePath('/cache', { dataset: 'klines', symbol: 'BTCUSDT', interval: '5m', date: '2024-01' })
    ).toBe('/cache/klines/BTCUSDT/5m/BTCUSDT-5m-2024-01.zip');
    expect(archiveCachePath('/cache', { dataset: 'metrics', symbol: 'BTCUSDT', date: '2024-01-02' })).toBe(
      '/cache/metrics/BTCUSDT/BTCUSDT-metrics-2024-01-02.zip'
    );
    expect(archiveFileName({ dataset: 'fundingRate', symbol: 'BTCUSDT', date: '2024-01' })).toBe(
      'BTCUSDT-fundingRate-2024-01.zip'
    );
  });
});

describe('parseArchiveTimestamp', () => {
  it('reads epoch milliseconds', () => {
    expect(parseArchiveTimestamp('1748736000000')).toBe(1748736000000);
  });

  it('reads the space-separated UTC form metrics and bookDepth use', () => {
    expect(parseArchiveTimestamp('2025-06-01 00:05:00')).toBe(Date.UTC(2025, 5, 1, 0, 5, 0));
  });

  it('treats the date as UTC regardless of the host timezone', () => {
    // Asia/Makassar is UTC+8; a local reading would land eight hours early.
    expect(parseArchiveTimestamp('2025-06-01 00:00:00')).toBe(1748736000000);
  });

  it('returns NaN rather than the epoch for junk', () => {
    expect(parseArchiveTimestamp('create_time')).toBeNaN();
    expect(parseArchiveTimestamp('')).toBeNaN();
    expect(parseArchiveTimestamp('2025-06-01')).toBeNaN();
    // More digits than milliseconds: microseconds would silently land in 57000 AD.
    expect(parseArchiveTimestamp('17487360000000000')).toBeNaN();
  });
});

describe('looksLikeHeader', () => {
  it('recognises the header rows Binance writes', () => {
    expect(looksLikeHeader('open_time,open,high,low,close,volume')).toBe(true);
    expect(looksLikeHeader('create_time,symbol,sum_open_interest')).toBe(true);
    expect(looksLikeHeader('timestamp,percentage,depth,notional')).toBe(true);
    expect(looksLikeHeader('calc_time,funding_interval_hours,last_funding_rate')).toBe(true);
  });

  it('does not mistake a data row for a header', () => {
    // Kline files written before about 2024 have no header at all.
    expect(looksLikeHeader('1635724800000,61347.14,61447.27')).toBe(false);
    expect(looksLikeHeader('2025-06-01 00:00:00,BTCUSDT,83624.19')).toBe(false);
  });
});

describe('parseMetricsCsv', () => {
  const csv = [
    'create_time,symbol,sum_open_interest,sum_open_interest_value,count_toptrader_long_short_ratio,sum_toptrader_long_short_ratio,count_long_short_ratio,sum_taker_long_short_vol_ratio',
    '2025-06-01 00:00:00,BTCUSDT,83624.1980000000000000,8736988614.4487060000000000,1.23458273,1.56163700,1.19060369,0.55280100',
    '2025-06-01 00:05:00,BTCUSDT,83584.7940000000000000,8734318426.2210000000000000,1.23146650,1.56293100,1.18671018,1.16437200',
    '',
  ].join('\n');

  it('parses every column of a real row', () => {
    const rows = parseMetricsCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      timestamp: Date.UTC(2025, 5, 1, 0, 0, 0),
      openInterest: 83624.198,
      openInterestValue: 8736988614.448706,
      topTraderAccountRatio: 1.23458273,
      topTraderPositionRatio: 1.561637,
      globalAccountRatio: 1.19060369,
      takerLongShortRatio: 0.552801,
    });
    expect(rows[1].timestamp - rows[0].timestamp).toBe(5 * 60 * 1000);
  });

  it('keeps the row but nulls a blank field, never zero', () => {
    const withGap = csv.replace('1.23458273', '');
    const rows = parseMetricsCsv(withGap);
    expect(rows[0].topTraderAccountRatio).toBeNull();
    expect(rows[0].openInterest).toBe(83624.198);
  });

  it('drops a row whose timestamp is unreadable', () => {
    expect(parseMetricsCsv(csv.replace('2025-06-01 00:05:00', 'garbage'))).toHaveLength(1);
  });
});

describe('parseKlineCsv', () => {
  const headerless = [
    '1635724800000,61347.14,61447.27,61129.90,61290.31,1705.548,1635725099999,104522700.64749,14001,638.680,39156061.31068,0',
    '1635725100000,61290.32,61463.79,61286.80,61447.96,628.579,1635725399999,38594107.25570,6338,447.397,27470417.87887,0',
  ].join('\n');

  const withHeader =
    'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n' +
    headerless;

  it('parses a file that has no header row', () => {
    const rows = parseKlineCsv(headerless);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      timestamp: 1635724800000,
      open: 61347.14,
      high: 61447.27,
      low: 61129.9,
      close: 61290.31,
      volume: 1705.548,
      quoteVolume: 104522700.64749,
      trades: 14001,
      takerBuyVolume: 638.68,
    });
  });

  it('parses the same rows when a header is present', () => {
    expect(parseKlineCsv(withHeader)).toEqual(parseKlineCsv(headerless));
  });

  it('drops a bar whose OHLC is incomplete rather than repairing it', () => {
    const broken = headerless.replace(',61447.27,', ',,');
    expect(parseKlineCsv(broken)).toHaveLength(1);
  });

  it('nulls a missing taker volume instead of reading it as no buying', () => {
    const rows = parseKlineCsv('1635724800000,1,2,0.5,1.5,10,1635725099999,15,7,,,0');
    expect(rows[0].takerBuyVolume).toBeNull();
    expect(rows[0].volume).toBe(10);
  });

  it('reads the premium index shape, where close is a small signed fraction', () => {
    const premium =
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore\n' +
      '1748736000000,-0.00048588,-0.00038573,-0.00090662,-0.00055034,0,1748736299999,0,60,0,0,0';
    const rows = parseKlineCsv(premium);
    expect(rows[0].close).toBeCloseTo(-0.00055034, 10);
    expect(rows[0].volume).toBe(0);
  });
});

describe('parseFundingCsv', () => {
  const csv = [
    'calc_time,funding_interval_hours,last_funding_rate',
    '1748736000001,8,-0.00000582',
    '1748764800002,8,0.00002335',
  ].join('\n');

  it('parses calc_time, interval and rate', () => {
    const rows = parseFundingCsv(csv);
    expect(rows).toEqual([
      { timestamp: 1748736000001, intervalHours: 8, rate: -0.00000582 },
      { timestamp: 1748764800002, intervalHours: 8, rate: 0.00002335 },
    ]);
    expect(rows[1].timestamp - rows[0].timestamp).toBe(8 * 60 * 60 * 1000 + 1);
  });

  it('drops a row with no rate', () => {
    expect(parseFundingCsv(csv.replace(',-0.00000582', ','))).toHaveLength(1);
  });
});

describe('parseBookDepthCsv', () => {
  const csv = [
    'timestamp,percentage,depth,notional',
    '2025-06-02 00:00:10,-5,7708.55000000,795335825.75690000',
    '2025-06-02 00:00:10,-1,1846.19200000,194035262.14000000',
    '2025-06-02 00:00:10,1,2747.22900000,291449666.44800000',
    '2025-06-02 00:00:10,5,6701.42700000,719804265.48500000',
    '2025-06-02 00:00:41,-1,1000.00000000,100000000.00000000',
    '2025-06-02 00:00:41,1,1000.00000000,300000000.00000000',
  ].join('\n');

  it('groups rows into one snapshot per timestamp', () => {
    const snapshots = parseBookDepthCsv(csv);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].timestamp).toBe(Date.UTC(2025, 5, 2, 0, 0, 10));
    expect(snapshots[0].notional.size).toBe(4);
    expect(snapshots[0].notional.get(-1)).toBe(194035262.14);
    expect(snapshots[0].depth.get(-1)).toBe(1846.192);
  });

  it('returns snapshots in timestamp order', () => {
    const snapshots = parseBookDepthCsv(csv);
    expect(snapshots[1].timestamp).toBeGreaterThan(snapshots[0].timestamp);
  });

  it('computes signed imbalance from notional, bid side positive', () => {
    const snapshots = parseBookDepthCsv(csv);
    // (194035262.14 - 291449666.448) / (194035262.14 + 291449666.448)
    expect(depthImbalance(snapshots[0], 1)).toBeCloseTo(-0.2006539, 6);
    expect(depthImbalance(snapshots[0], 5)).toBeCloseTo(0.0498512, 6);
    // The sign of the argument must not matter.
    expect(depthImbalance(snapshots[0], -1)).toBe(depthImbalance(snapshots[0], 1));
    // A clean 1:3 split.
    expect(depthImbalance(snapshots[1], 1)).toBeCloseTo(-0.5, 10);
  });

  it('returns null when one side of the band is missing', () => {
    const snapshots = parseBookDepthCsv(csv);
    expect(depthImbalance(snapshots[0], 2)).toBeNull();
    expect(depthImbalance(snapshots[1], 5)).toBeNull();
  });
});

describe('fetchArchiveFile', () => {
  const mockFetch = vi.fn();
  let cacheDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    cacheDir = mkdtempSync(join(tmpdir(), 'archive-cache-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const spec = { dataset: 'metrics', symbol: 'BTCUSDT', date: '2025-06-01' } as const;

  function okResponse(contents: string) {
    const zip = buildZip('BTCUSDT-metrics-2025-06-01.csv', contents);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
    };
  }

  it('returns the decompressed csv', async () => {
    mockFetch.mockResolvedValue(okResponse('a,b\n1,2\n'));
    await expect(fetchArchiveFile(spec)).resolves.toBe('a,b\n1,2\n');
  });

  it('returns null on 404 instead of throwing', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchArchiveFile(spec)).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 and succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(okResponse('recovered\n'));
    await expect(fetchArchiveFile(spec, { retryBaseMs: 0 })).resolves.toBe('recovered\n');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries a network error and succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(okResponse('recovered\n'));
    await expect(fetchArchiveFile(spec, { retryBaseMs: 0 })).resolves.toBe('recovered\n');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after four attempts', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchArchiveFile(spec, { retryBaseMs: 0 })).rejects.toThrow(/HTTP 500/);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry a 4xx that is not 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    await expect(fetchArchiveFile(spec)).rejects.toThrow(/HTTP 403/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('writes the zip to the cache and serves the second read from it', async () => {
    mockFetch.mockResolvedValue(okResponse('cached,row\n'));
    await expect(fetchArchiveFile(spec, { cacheDir })).resolves.toBe('cached,row\n');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await expect(fetchArchiveFile(spec, { cacheDir })).resolves.toBe('cached,row\n');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    expect(readFileSync(archiveCachePath(cacheDir, spec)).length).toBeGreaterThan(0);
  });

  it('refetches when refresh is set', async () => {
    mockFetch.mockResolvedValue(okResponse('x\n'));
    await fetchArchiveFile(spec, { cacheDir });
    await fetchArchiveFile(spec, { cacheDir, refresh: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('remembers a 404 as an empty cache file and does not refetch it', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchArchiveFile(spec, { cacheDir })).resolves.toBeNull();
    expect(readFileSync(archiveCachePath(cacheDir, spec)).length).toBe(0);

    await expect(fetchArchiveFile(spec, { cacheDir })).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reads a cache file written by an earlier run', async () => {
    const path = archiveCachePath(cacheDir, spec);
    mkdirSync(join(cacheDir, 'metrics', 'BTCUSDT'), { recursive: true });
    writeFileSync(path, buildZip('x.csv', 'from,disk\n'));
    await expect(fetchArchiveFile(spec, { cacheDir })).resolves.toBe('from,disk\n');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('csvHash', () => {
  it('is stable and content-addressed', () => {
    expect(csvHash('a,b\n')).toBe(csvHash('a,b\n'));
    expect(csvHash('a,b\n')).not.toBe(csvHash('a,c\n'));
    expect(csvHash('a,b\n')).toMatch(/^[0-9a-f]{64}$/);
  });
});
