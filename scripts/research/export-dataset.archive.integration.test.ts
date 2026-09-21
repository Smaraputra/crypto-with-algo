// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { PerpCandle } from '@/lib/models/perp-candle';
import { FuturesMetric } from '@/lib/models/futures-metric';
import { mergeManifestFiles, runExport } from './export-dataset';
import { loadManifest, loadMetrics, loadPerp, verifyManifest } from './load-dataset';
import { LOCKBOX_START, type DatasetManifest, type ManifestFile } from './dataset-format';

const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const HOUR = 60 * 60 * 1000;
const SLOT = 5 * 60 * 1000;

// Straddles the lockbox so the export keeps everything and the loader cuts it.
const FIRST_BAR = LOCKBOX_START - 3 * HOUR;

let mongoServer: MongoMemoryServer;
let outDir: string;
let manifest: DatasetManifest;

describe('export-dataset: perp and metrics kinds', () => {
  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    await PerpCandle.insertMany(
      Array.from({ length: 6 }, (_, i) => ({
        symbol: SYMBOL,
        interval: INTERVAL,
        series: 'klines' as const,
        timestamp: FIRST_BAR + i * HOUR,
        open: 100 + i,
        high: 101 + i,
        low: 99 + i,
        close: 100.5 + i,
        volume: 10 + i,
        quoteVolume: 1000 + i,
        trades: 50 + i,
        ...(i === 0 ? {} : { takerBuyVolume: 4 + i }),
      }))
    );

    await PerpCandle.insertMany(
      Array.from({ length: 6 }, (_, i) => ({
        symbol: SYMBOL,
        interval: INTERVAL,
        series: 'premiumIndex' as const,
        timestamp: FIRST_BAR + i * HOUR,
        open: -0.0004,
        high: -0.0003,
        low: -0.0009,
        close: -0.0005 - i / 100000,
        volume: 0,
        quoteVolume: 0,
        trades: 60,
      }))
    );

    // 5m grid across the same span, with a deliberate hole in one measure.
    await FuturesMetric.insertMany(
      Array.from({ length: 6 * 12 }, (_, i) => ({
        symbol: SYMBOL,
        timestamp: FIRST_BAR + i * SLOT,
        openInterest: 1000 + i,
        openInterestValue: 100000 + i,
        globalAccountRatio: 1 + i / 100,
        ...(i % 2 === 0 ? { takerLongShortRatio: 0.9 + i / 1000 } : {}),
        ...(i % 3 === 0 ? { depthImbalance1: -0.1, depthSamples: 10 } : {}),
      }))
    );

    outDir = mkdtempSync(join(tmpdir(), 'export-archive-'));
    manifest = await runExport({
      symbols: [SYMBOL],
      intervals: [INTERVAL],
      kinds: ['perp', 'metrics'],
      perpSeries: ['klines', 'premiumIndex'],
      out: outDir,
      mongoUri: mongoServer.getUri(),
    });
  }, 60_000);

  afterAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('writes one file per perp series and one metrics file per symbol', () => {
    const paths = manifest.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      `metrics/${SYMBOL}/5m.jsonl.gz`,
      `perp/${SYMBOL}/${INTERVAL}.jsonl.gz`,
      `perp/${SYMBOL}/${INTERVAL}.premiumIndex.jsonl.gz`,
    ]);
  });

  it('writes no candles, snapshots or htf when those kinds are not asked for', () => {
    expect(manifest.files.some((f) => f.kind === 'candles')).toBe(false);
    expect(manifest.files.some((f) => f.kind === 'htf')).toBe(false);
    expect(manifest.files.some((f) => f.kind === 'snapshots')).toBe(false);
  });

  it('records the metrics file at its own 5m interval, not the export interval', () => {
    const metricsFile = manifest.files.find((f) => f.kind === 'metrics')!;
    expect(metricsFile.interval).toBe('5m');
    expect(metricsFile.rowCount).toBe(72);
  });

  it('produces a verifying manifest', async () => {
    await expect(verifyManifest(outDir)).resolves.toEqual({ ok: true, mismatches: [] });
    expect(loadManifest(outDir).datasetHash).toBe(manifest.datasetHash);
  });

  it('round-trips perpetual bars, quote volume and trade count included', () => {
    const rows = loadPerp(outDir, SYMBOL, INTERVAL, 'klines', { allowLockbox: true }).rows;
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      t: FIRST_BAR, o: 100, h: 101, l: 99, c: 100.5, v: 10, qv: 1000, n: 50, tbv: null,
    });
    expect(rows[1].tbv).toBe(5);
  });

  it('round-trips the premium index series under its own file', () => {
    const rows = loadPerp(outDir, SYMBOL, INTERVAL, 'premiumIndex', { allowLockbox: true }).rows;
    expect(rows).toHaveLength(6);
    expect(rows[0].c).toBeCloseTo(-0.0005, 10);
    expect(rows[0].v).toBe(0);
  });

  it('round-trips metrics with missing measures as null, not zero', () => {
    const rows = loadMetrics(outDir, SYMBOL, { allowLockbox: true }).rows;
    expect(rows).toHaveLength(72);
    expect(rows[0].openInterest).toBe(1000);
    expect(rows[0].takerLongShortRatio).toBeCloseTo(0.9, 10);
    expect(rows[1].takerLongShortRatio).toBeNull();
    expect(rows[0].depthImbalance1).toBeCloseTo(-0.1, 10);
    expect(rows[1].depthImbalance1).toBeNull();
    expect(rows[0].depthNotional5).toBeNull();
  });

  it('exports rows in ascending timestamp order', () => {
    const rows = loadMetrics(outDir, SYMBOL, { allowLockbox: true }).rows;
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].t).toBeGreaterThan(rows[i - 1].t);
    }
  });

  it('holds the lockbox window out of both kinds by default', () => {
    const perp = loadPerp(outDir, SYMBOL, INTERVAL);
    const metrics = loadMetrics(outDir, SYMBOL);
    expect(perp.rows).toHaveLength(3);
    expect(perp.droppedRows).toBe(3);
    expect(perp.rows.every((r) => r.t < LOCKBOX_START)).toBe(true);
    expect(metrics.rows.every((r) => r.t < LOCKBOX_START)).toBe(true);
    expect(metrics.droppedRows).toBeGreaterThan(0);
  });
});

describe('mergeManifestFiles', () => {
  function file(path: string, kind: ManifestFile['kind'], sha: string): ManifestFile {
    return {
      path, kind, symbol: 'BTCUSDT', interval: '1h',
      rowCount: 1, startMs: 1, endMs: 2, sha256: sha,
    };
  }

  it('returns just the written files when there is no manifest to merge into', () => {
    const written = [file('perp/BTCUSDT/1h.jsonl.gz', 'perp', 'a')];
    expect(mergeManifestFiles('/definitely/not/a/directory', written)).toEqual(written);
  });

  it('keeps files a partial run did not rewrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-manifest-'));
    try {
      const existing: DatasetManifest = {
        version: 1, generatedAt: 'x', commit: 'y', lockboxStart: 'z',
        symbols: ['BTCUSDT'], intervals: ['1h'],
        files: [
          file('candles/BTCUSDT/1h.jsonl.gz', 'candles', 'keep-me'),
          file('snapshots/BTCUSDT/1h.jsonl.gz', 'snapshots', 'old-sha'),
        ],
        datasetHash: 'whatever',
      };
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(existing));

      const merged = mergeManifestFiles(dir, [
        file('snapshots/BTCUSDT/1h.jsonl.gz', 'snapshots', 'new-sha'),
      ]);

      expect(merged.map((f) => f.path)).toEqual([
        'candles/BTCUSDT/1h.jsonl.gz',
        'snapshots/BTCUSDT/1h.jsonl.gz',
      ]);
      // The rewritten entry carries the new hash, the untouched one is intact.
      expect(merged.find((f) => f.kind === 'snapshots')!.sha256).toBe('new-sha');
      expect(merged.find((f) => f.kind === 'candles')!.sha256).toBe('keep-me');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats an unreadable manifest as absent rather than failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'merge-manifest-'));
    try {
      writeFileSync(join(dir, 'manifest.json'), 'not json at all');
      const written = [file('metrics/BTCUSDT/5m.jsonl.gz', 'metrics', 'a')];
      expect(mergeManifestFiles(dir, written)).toEqual(written);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
