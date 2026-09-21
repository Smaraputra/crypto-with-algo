// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Candle } from '@/lib/models/candle';
import { intervalToMs } from '@/lib/intervals';
import { runExport } from './export-dataset';
import { readJsonlGz, type CandleRow, type HtfRow } from './dataset-format';

const SYMBOL = 'ETHUSDT';
const LTF_START = Date.UTC(2026, 0, 1);

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
    });

    price = close;
  }

  return docs;
}

describe('export-dataset with sparse HTF data (mongodb-memory-server)', () => {
  let mongoServer: MongoMemoryServer;
  let outDir: string;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const ltfDocs = makeCandleDocs('1h', 50, intervalToMs('1h'), LTF_START);
    // Fewer than SuperTrend's minimum (11 candles by default): computeHtfSeries
    // must degrade to null contexts instead of throwing and aborting the
    // whole export.
    const htfDocs = makeCandleDocs('4h', 5, intervalToMs('4h'), LTF_START - 20 * intervalToMs('4h'));
    await Candle.insertMany([...ltfDocs, ...htfDocs]);

    outDir = mkdtempSync(join(tmpdir(), 'export-dataset-sparse-htf-'));

    await runExport({
      symbols: [SYMBOL],
      intervals: ['1h'],
      // This suite predates the perp and metrics kinds and asserts on the
      // exact file list, so it exports only the three it was written for.
      kinds: ['candles', 'snapshots', 'htf'],
      perpSeries: ['klines'],
      out: outDir,
      mongoUri: mongoServer.getUri(),
    });
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('completes the export instead of throwing on too few HTF candles', () => {
    const candleRows = readJsonlGz<CandleRow>(join(outDir, 'candles', SYMBOL, '1h.jsonl.gz'));

    expect(candleRows).toHaveLength(50);
  });

  it('writes an htf file with all-null contexts and a row count matching the candle file', () => {
    const candleRows = readJsonlGz<CandleRow>(join(outDir, 'candles', SYMBOL, '1h.jsonl.gz'));
    const htfRows = readJsonlGz<HtfRow>(join(outDir, 'htf', SYMBOL, '1h.jsonl.gz'));

    expect(htfRows).toHaveLength(candleRows.length);
    expect(htfRows.every((row) => row.context === null)).toBe(true);
  });
});
