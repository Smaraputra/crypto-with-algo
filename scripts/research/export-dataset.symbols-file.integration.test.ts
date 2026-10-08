// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { PerpCandle } from '@/lib/models/perp-candle';
import { runExport } from './export-dataset';

const DAY = 24 * 60 * 60 * 1000;
const FIRST = Date.UTC(2022, 0, 1);

let mongoServer: MongoMemoryServer;
const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'export-symbols-file-'));
  dirs.push(dir);
  return dir;
}

function args(symbols: string[], out: string) {
  return {
    symbols,
    symbolsFile: 'list.json',
    intervals: ['1d'],
    kinds: ['perp' as const],
    perpSeries: ['klines' as const],
    out,
    mongoUri: mongoServer.getUri(),
  };
}

describe('export-dataset --symbols-file mode', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    await PerpCandle.insertMany(
      Array.from({ length: 3 }, (_, i) => ({
        symbol: 'LUNAUSDT',
        interval: '1d',
        series: 'klines' as const,
        timestamp: FIRST + i * DAY,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 10,
        quoteVolume: 15,
        trades: 5,
      }))
    );
    await mongoose.disconnect();
  }, 60_000);

  afterAll(async () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await mongoServer.stop();
  });

  it('exports a fresh directory when every symbol has rows', async () => {
    const out = freshDir();
    const manifest = await runExport(args(['LUNAUSDT'], out));
    expect(manifest.files.map((f) => f.path)).toEqual(['perp/LUNAUSDT/1d.jsonl.gz']);
    expect(manifest.files[0].rowCount).toBe(3);
  });

  it('refuses a non-empty output directory before touching the database', async () => {
    const out = freshDir();
    writeFileSync(join(out, 'manifest.json'), '{}');
    await expect(runExport(args(['LUNAUSDT'], out))).rejects.toThrow(/fresh --out directory/);
  });

  it('collects every symbol with zero rows, fails at the end and writes no manifest', async () => {
    const out = freshDir();
    await expect(runExport(args(['LUNAUSDT', 'AUSDT', 'BUSDT'], out))).rejects.toThrow(
      /2 item\(s\), no manifest written:\nAUSDT: zero rows for perp 1d\nBUSDT: zero rows for perp 1d/
    );
    expect(existsSync(join(out, 'manifest.json'))).toBe(false);
  });
});
