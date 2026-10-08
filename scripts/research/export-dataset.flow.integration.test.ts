// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { ArchiveFlowBar } from '@/lib/models/archive-flow-bar';
import { runExport } from './export-dataset';
import { loadFlow, loadManifest, verifyManifest } from './load-dataset';
import { LOCKBOX_START, type DatasetManifest } from './dataset-format';

const SYMBOL = 'BTCUSDT';
const OTHER = 'ETHUSDT';
const SLOT = 5 * 60 * 1000;
// Six buckets before the lockbox and six from 2026-07-01 on.
const FIRST = LOCKBOX_START - 6 * SLOT;

function bucket(symbol: string, i: number) {
  return {
    symbol,
    bucketStart: FIRST + i * SLOT,
    trades: 10 + i,
    aggTrades: 5 + i,
    buyBase: 1 + i,
    sellBase: 2 + i,
    buyQuote: 100 + i,
    sellQuote: 90 + i,
    buyQuoteSmall: 10 + i,
    buyQuoteMedium: 20 + i,
    buyQuoteLarge: 70 + i,
    sellQuoteSmall: 11 + i,
    sellQuoteMedium: 21 + i,
    sellQuoteLarge: 58 + i,
    buyQuoteOpen10s: 3 + i,
    sellQuoteOpen10s: 1 + i,
    source: 'BTCUSDT-aggTrades-2026-06.zip',
  };
}

let mongoServer: MongoMemoryServer;
let outDir: string;
let manifest: DatasetManifest;

describe('export-dataset: flow kind', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    // Inserted out of order to prove the export sorts by bucket open.
    const order = [3, 0, 11, 5, 1, 9, 2, 4, 10, 6, 7, 8];
    await ArchiveFlowBar.insertMany(order.map((i) => bucket(SYMBOL, i)));
    await ArchiveFlowBar.insertMany([bucket(OTHER, 0)]);

    outDir = mkdtempSync(join(tmpdir(), 'export-flow-'));
    manifest = await runExport({
      symbols: [SYMBOL],
      intervals: ['1h'],
      kinds: ['flow'],
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

  it('writes one flow file per symbol at flow/<SYMBOL>/5m.jsonl.gz and nothing else', () => {
    expect(manifest.files.map((f) => f.path)).toEqual([`flow/${SYMBOL}/5m.jsonl.gz`]);
    const file = manifest.files[0];
    expect(file.kind).toBe('flow');
    expect(file.interval).toBe('5m');
    expect(file.rowCount).toBe(12);
    expect(file.startMs).toBe(FIRST);
    expect(file.endMs).toBe(FIRST + 11 * SLOT);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the hash in a verifying manifest', async () => {
    await expect(verifyManifest(outDir)).resolves.toEqual({ ok: true, mismatches: [] });
    expect(loadManifest(outDir).files[0].sha256).toBe(manifest.files[0].sha256);
  });

  it('round-trips every flow field, ascending by t, for the requested symbol only', () => {
    const rows = loadFlow(outDir, SYMBOL, { allowLockbox: true }).rows;
    expect(rows).toHaveLength(12);
    for (let i = 1; i < rows.length; i++) expect(rows[i].t).toBeGreaterThan(rows[i - 1].t);
    expect(rows[4]).toEqual({
      t: FIRST + 4 * SLOT,
      trades: 14,
      aggTrades: 9,
      buyBase: 5,
      sellBase: 6,
      buyQuote: 104,
      sellQuote: 94,
      buyQuoteSmall: 14,
      buyQuoteMedium: 24,
      buyQuoteLarge: 74,
      sellQuoteSmall: 15,
      sellQuoteMedium: 25,
      sellQuoteLarge: 62,
      buyQuoteOpen10s: 7,
      sellQuoteOpen10s: 5,
      source: 'BTCUSDT-aggTrades-2026-06.zip',
    });
  });

  it('drops rows from 2026-07-01 on by default and keeps them with allowLockbox', () => {
    const held = loadFlow(outDir, SYMBOL);
    expect(held.rows).toHaveLength(6);
    expect(held.droppedRows).toBe(6);
    expect(held.rows.every((r) => r.t < LOCKBOX_START)).toBe(true);
    expect(loadFlow(outDir, SYMBOL, { allowLockbox: true }).rows).toHaveLength(12);
  });

  it('honours --start and --end on bucketStart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'export-flow-window-'));
    try {
      const windowed = await runExport({
        symbols: [SYMBOL],
        intervals: ['1h'],
        kinds: ['flow'],
        perpSeries: ['klines'],
        start: FIRST + 2 * SLOT,
        end: FIRST + 4 * SLOT,
        out: dir,
        mongoUri: mongoServer.getUri(),
      });
      expect(windowed.files[0].rowCount).toBe(3);
      expect(windowed.files[0].startMs).toBe(FIRST + 2 * SLOT);
      expect(windowed.files[0].endMs).toBe(FIRST + 4 * SLOT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
