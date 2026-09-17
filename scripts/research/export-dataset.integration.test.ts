// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Candle } from '@/lib/models/candle';
import { HistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { intervalToMs } from '@/lib/intervals';
import { runExport } from './export-dataset';
import { readJsonlGz, type CandleRow, type DatasetManifest, type HtfRow, type SnapshotRow } from './dataset-format';

const SYMBOL = 'BTCUSDT';
const LTF_START = Date.UTC(2026, 0, 1);
const HTF_START = Date.UTC(2025, 11, 20); // starts before the LTF window on purpose

function makeCandleDocs(interval: string, count: number, intervalMs: number, startTs: number) {
  const docs = [];
  let price = 100;

  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price * (1 + Math.sin(i / 5) * 0.01);
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;

    docs.push({
      symbol: SYMBOL,
      interval,
      timestamp: startTs + i * intervalMs,
      open,
      high,
      low,
      close,
      volume: 100 + i,
      takerBuyVolume: 50 + i,
    });

    price = close;
  }

  return docs;
}

describe('export-dataset end-to-end (mongodb-memory-server)', () => {
  let mongoServer: MongoMemoryServer;
  let outDir: string;
  let manifest: DatasetManifest;
  let ltfCandleDocs: ReturnType<typeof makeCandleDocs>;
  let snapshotTimestamps: number[];

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    ltfCandleDocs = makeCandleDocs('1h', 300, intervalToMs('1h'), LTF_START);
    const htfCandleDocs = makeCandleDocs('4h', 80, intervalToMs('4h'), HTF_START);
    await Candle.insertMany([...ltfCandleDocs, ...htfCandleDocs]);

    snapshotTimestamps = [
      ltfCandleDocs[0].timestamp,
      ltfCandleDocs[10].timestamp,
      ltfCandleDocs[20].timestamp,
    ];
    await HistoricalSnapshot.insertMany(
      snapshotTimestamps.map((timestamp, i) => ({
        symbol: SYMBOL,
        interval: '1h',
        timestamp,
        data: {
          fundingRate: { rate: 0.0001 * (i + 1), markPrice: 60000 + i },
          fearGreed: { index: 40 + i, label: 'Fear' },
        },
      }))
    );

    outDir = mkdtempSync(join(tmpdir(), 'export-dataset-'));

    manifest = await runExport({
      symbols: [SYMBOL],
      intervals: ['1h'],
      out: outDir,
      mongoUri: mongoServer.getUri(),
    });
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('writes candle, snapshot, and htf files for 1h', () => {
    expect(existsSync(join(outDir, 'candles', SYMBOL, '1h.jsonl.gz'))).toBe(true);
    expect(existsSync(join(outDir, 'snapshots', SYMBOL, '1h.jsonl.gz'))).toBe(true);
    expect(existsSync(join(outDir, 'htf', SYMBOL, '1h.jsonl.gz'))).toBe(true);
  });

  it('htf row count equals the candle row count', () => {
    const candleRows = readJsonlGz<CandleRow>(join(outDir, 'candles', SYMBOL, '1h.jsonl.gz'));
    const htfRows = readJsonlGz<HtfRow>(join(outDir, 'htf', SYMBOL, '1h.jsonl.gz'));

    expect(candleRows).toHaveLength(300);
    expect(htfRows).toHaveLength(candleRows.length);
    expect(htfRows.map((r) => r.t)).toEqual(candleRows.map((r) => r.t));
  });

  it('every non-null htf context references an htf candle closing at or before the ltf close', () => {
    const htfRows = readJsonlGz<HtfRow>(join(outDir, 'htf', SYMBOL, '1h.jsonl.gz'));
    const ltfMs = intervalToMs('1h');
    const htfMs = intervalToMs('4h');

    const nonNull = htfRows.filter((row) => row.context !== null);

    for (const row of nonNull) {
      const htfClose = row.context!.candleTimestamp + htfMs;
      const ltfClose = row.t + ltfMs;
      expect(htfClose).toBeLessThanOrEqual(ltfClose);
    }
  });

  it('writes the seeded snapshot rows', () => {
    const snapshotRows = readJsonlGz<SnapshotRow>(join(outDir, 'snapshots', SYMBOL, '1h.jsonl.gz'));

    expect(snapshotRows).toHaveLength(snapshotTimestamps.length);
    expect(snapshotRows.map((r) => r.t)).toEqual(snapshotTimestamps);
    expect(snapshotRows[0].fundingRate).toEqual({ rate: 0.0001, markPrice: 60000 });
    expect(snapshotRows[0].fearGreed).toEqual({ index: 40, label: 'Fear' });
    expect(snapshotRows[0].longShortRatio).toBeNull();
    expect(snapshotRows[0].openInterest).toBeNull();
    expect(snapshotRows[0].newsSentiment).toBeNull();
  });

  it('lists every file in the manifest with correct counts and a verifying hash', async () => {
    const { datasetHashOf, sha256File } = await import('./dataset-format');

    expect(manifest.version).toBe(1);
    expect(manifest.symbols).toEqual([SYMBOL]);
    expect(manifest.intervals).toEqual(['1h']);
    expect(manifest.files).toHaveLength(3);

    const candleFile = manifest.files.find((f) => f.kind === 'candles')!;
    expect(candleFile.rowCount).toBe(300);
    expect(candleFile.startMs).toBe(ltfCandleDocs[0].timestamp);
    expect(candleFile.endMs).toBe(ltfCandleDocs[ltfCandleDocs.length - 1].timestamp);

    const snapshotFile = manifest.files.find((f) => f.kind === 'snapshots')!;
    expect(snapshotFile.rowCount).toBe(3);

    const htfFile = manifest.files.find((f) => f.kind === 'htf')!;
    expect(htfFile.rowCount).toBe(300);

    for (const file of manifest.files) {
      const actualSha = await sha256File(join(outDir, file.path));
      expect(actualSha).toBe(file.sha256);
    }

    expect(datasetHashOf(manifest.files)).toBe(manifest.datasetHash);
  });
});
