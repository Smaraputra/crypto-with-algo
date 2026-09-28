// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { OptionsFlowHour } from '@/lib/models/options-flow-hour';
import { runExport } from './export-dataset';
import { loadManifest, loadOptions, verifyManifest } from './load-dataset';
import { LOCKBOX_START, type DatasetManifest } from './dataset-format';

const HOUR = 60 * 60 * 1000;
// Straddles the lockbox so the export keeps everything and the loader cuts it.
const FIRST_HOUR = LOCKBOX_START - 3 * HOUR;

let mongoServer: MongoMemoryServer;
let outDir: string;
let manifest: DatasetManifest;

describe('export-dataset: options kind', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    // BTC: dvol and trade-flow rows, with a deliberate hole in one measure so
    // the null-vs-zero distinction is exercised.
    await OptionsFlowHour.insertMany(
      Array.from({ length: 6 }, (_, i) => ({
        currency: 'BTC',
        timestamp: FIRST_HOUR + i * HOUR,
        dvolOpen: 60 + i,
        dvolHigh: 61 + i,
        dvolLow: 59 + i,
        dvolClose: 60.5 + i,
        callBuyNotional: 1_000_000 + i,
        putSellNotional: 500_000 + i,
        netDelta: 10 + i,
        tradeCount: 42 + i,
        vwIv: 65 + i,
        ...(i % 2 === 0 ? { greekTradeCount: 5 + i } : {}),
      }))
    );

    // ETH: one row, so its own file is written once too.
    await OptionsFlowHour.insertMany([
      {
        currency: 'ETH',
        timestamp: FIRST_HOUR,
        dvolClose: 70,
        tradeCount: 5,
      },
    ]);

    outDir = mkdtempSync(join(tmpdir(), 'export-options-'));
    manifest = await runExport({
      symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
      intervals: ['1h'],
      kinds: ['options'],
      perpSeries: ['klines'],
      out: outDir,
      mongoUri: mongoServer.getUri(),
    });
  }, 60_000);

  afterAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('writes one options file per currency, recorded under the USDT symbol', () => {
    const paths = manifest.files.map((f) => f.path).sort();
    expect(paths).toEqual(['options/BTC/1h.jsonl.gz', 'options/ETH/1h.jsonl.gz']);

    const btcFile = manifest.files.find((f) => f.path === 'options/BTC/1h.jsonl.gz')!;
    expect(btcFile.symbol).toBe('BTCUSDT');
    expect(btcFile.interval).toBe('1h');
    expect(btcFile.kind).toBe('options');

    const ethFile = manifest.files.find((f) => f.path === 'options/ETH/1h.jsonl.gz')!;
    expect(ethFile.symbol).toBe('ETHUSDT');
  });

  it('writes nothing for a symbol with no options currency', () => {
    expect(manifest.files.some((f) => f.symbol === 'SOLUSDT')).toBe(false);
  });

  it('records no currency in manifest.symbols, only the USDT symbols', () => {
    expect(manifest.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('produces a verifying manifest', async () => {
    await expect(verifyManifest(outDir)).resolves.toEqual({ ok: true, mismatches: [] });
    expect(loadManifest(outDir).datasetHash).toBe(manifest.datasetHash);
  });

  it('round-trips the BTC options series with nulls, never zeros, for absent measures', () => {
    const rows = loadOptions(outDir, 'BTC', { allowLockbox: true }).rows;
    expect(rows).toHaveLength(6);
    expect(rows[0].dvolClose).toBeCloseTo(60.5, 10);
    expect(rows[0].callBuyNotional).toBe(1_000_000);
    expect(rows[0].callSellNotional).toBeNull();
    expect(rows[0].putBuyNotional).toBeNull();
    expect(rows[0].netDollarGamma).toBeNull();
    expect(rows[0].greekTradeCount).toBe(5);
    expect(rows[1].greekTradeCount).toBeNull();
    expect(rows[0].putIv25).toBeNull();
    expect(rows[0].callIv25).toBeNull();
  });

  it('exports rows in ascending timestamp order', () => {
    const rows = loadOptions(outDir, 'BTC', { allowLockbox: true }).rows;
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].t).toBeGreaterThan(rows[i - 1].t);
    }
  });

  it('holds the lockbox window out by default', () => {
    const result = loadOptions(outDir, 'BTC');
    expect(result.rows).toHaveLength(3);
    expect(result.droppedRows).toBe(3);
    expect(result.rows.every((r) => r.t < LOCKBOX_START)).toBe(true);
  });

  it('a --datasets options run into a directory with a manifest keeps every other entry and rehashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'export-options-merge-'));
    try {
      // First an unrelated kind (metrics)...
      await runExport({
        symbols: ['BTCUSDT'],
        intervals: ['1h'],
        kinds: ['metrics'],
        perpSeries: ['klines'],
        out: dir,
        mongoUri: mongoServer.getUri(),
      });
      const afterMetrics = loadManifest(dir);
      expect(afterMetrics.files.map((f) => f.path)).toEqual(['metrics/BTCUSDT/5m.jsonl.gz']);
      const priorHash = afterMetrics.datasetHash;

      // ...then a partial --datasets options run.
      const afterOptions = await runExport({
        symbols: ['BTCUSDT', 'ETHUSDT'],
        intervals: ['1h'],
        kinds: ['options'],
        perpSeries: ['klines'],
        out: dir,
        mongoUri: mongoServer.getUri(),
      });

      const paths = afterOptions.files.map((f) => f.path).sort();
      expect(paths).toEqual([
        'metrics/BTCUSDT/5m.jsonl.gz',
        'options/BTC/1h.jsonl.gz',
        'options/ETH/1h.jsonl.gz',
      ]);
      expect(afterOptions.datasetHash).not.toBe(priorHash);
      await expect(verifyManifest(dir)).resolves.toEqual({ ok: true, mismatches: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
