// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LOCKBOX_START,
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type HtfRow,
  type ManifestFile,
  type MetricsRow,
  type PerpCandleRow,
  type SnapshotRow,
} from './dataset-format';
import {
  loadCandles,
  loadHtf,
  loadManifest,
  loadMetrics,
  loadPerp,
  loadSnapshots,
  verifyManifest,
} from './load-dataset';

const SYMBOL = 'BTCUSDT';
const INTERVAL = '1h';
const HOUR = 3_600_000;

// Straddles the lockbox boundary: two rows strictly before it, two at/after.
const TIMESTAMPS = [
  LOCKBOX_START - 2 * HOUR,
  LOCKBOX_START - HOUR,
  LOCKBOX_START,
  LOCKBOX_START + HOUR,
];

async function buildFixtureDataset(dir: string): Promise<DatasetManifest> {
  const candleRows: CandleRow[] = TIMESTAMPS.map((t, i) => ({
    t,
    o: 100 + i,
    h: 101 + i,
    l: 99 + i,
    c: 100.5 + i,
    v: 10 + i,
    tbv: null,
  }));
  const htfRows: HtfRow[] = TIMESTAMPS.map((t) => ({ t, context: null }));
  const snapshotRows: SnapshotRow[] = TIMESTAMPS.map((t) => ({
    t,
    fundingRate: null,
    longShortRatio: null,
    openInterest: null,
    fearGreed: null,
    newsSentiment: null,
  }));

  const perpRows: PerpCandleRow[] = TIMESTAMPS.map((t, i) => ({
    t,
    o: 200 + i,
    h: 201 + i,
    l: 199 + i,
    c: 200.5 + i,
    v: 20 + i,
    qv: 2000 + i,
    n: 5 + i,
    tbv: null,
  }));
  const metricsRows: MetricsRow[] = TIMESTAMPS.map((t, i) => ({
    t,
    openInterest: 1000 + i,
    openInterestValue: 100000 + i,
    topTraderAccountRatio: null,
    topTraderPositionRatio: null,
    globalAccountRatio: 1 + i / 10,
    takerLongShortRatio: null,
    depthImbalance1: null,
    depthImbalance2: null,
    depthImbalance5: null,
    depthNotional1: null,
    depthNotional5: null,
  }));

  const candlePath = join(dir, 'candles', SYMBOL, `${INTERVAL}.jsonl.gz`);
  const perpPath = join(dir, 'perp', SYMBOL, `${INTERVAL}.jsonl.gz`);
  const metricsPath = join(dir, 'metrics', SYMBOL, '5m.jsonl.gz');
  const htfPath = join(dir, 'htf', SYMBOL, `${INTERVAL}.jsonl.gz`);
  const snapshotPath = join(dir, 'snapshots', SYMBOL, `${INTERVAL}.jsonl.gz`);

  await writeJsonlGz(candlePath, candleRows);
  await writeJsonlGz(htfPath, htfRows);
  await writeJsonlGz(snapshotPath, snapshotRows);
  await writeJsonlGz(perpPath, perpRows);
  await writeJsonlGz(metricsPath, metricsRows);

  const files: ManifestFile[] = [
    {
      path: `candles/${SYMBOL}/${INTERVAL}.jsonl.gz`,
      kind: 'candles',
      symbol: SYMBOL,
      interval: INTERVAL,
      rowCount: candleRows.length,
      startMs: candleRows[0].t,
      endMs: candleRows[candleRows.length - 1].t,
      sha256: await sha256File(candlePath),
    },
    {
      path: `htf/${SYMBOL}/${INTERVAL}.jsonl.gz`,
      kind: 'htf',
      symbol: SYMBOL,
      interval: INTERVAL,
      rowCount: htfRows.length,
      startMs: htfRows[0].t,
      endMs: htfRows[htfRows.length - 1].t,
      sha256: await sha256File(htfPath),
    },
    {
      path: `snapshots/${SYMBOL}/${INTERVAL}.jsonl.gz`,
      kind: 'snapshots',
      symbol: SYMBOL,
      interval: INTERVAL,
      rowCount: snapshotRows.length,
      startMs: snapshotRows[0].t,
      endMs: snapshotRows[snapshotRows.length - 1].t,
      sha256: await sha256File(snapshotPath),
    },
    {
      path: `perp/${SYMBOL}/${INTERVAL}.jsonl.gz`,
      kind: 'perp',
      symbol: SYMBOL,
      interval: INTERVAL,
      rowCount: perpRows.length,
      startMs: perpRows[0].t,
      endMs: perpRows[perpRows.length - 1].t,
      sha256: await sha256File(perpPath),
    },
    {
      path: `metrics/${SYMBOL}/5m.jsonl.gz`,
      kind: 'metrics',
      symbol: SYMBOL,
      interval: '5m',
      rowCount: metricsRows.length,
      startMs: metricsRows[0].t,
      endMs: metricsRows[metricsRows.length - 1].t,
      sha256: await sha256File(metricsPath),
    },
  ];

  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    commit: 'test-fixture',
    lockboxStart: LOCKBOX_START_ISO,
    symbols: [SYMBOL],
    intervals: [INTERVAL],
    files,
    datasetHash: datasetHashOf(files),
  };

  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe('loadManifest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'load-dataset-'));
    await buildFixtureDataset(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the manifest written to disk', () => {
    const manifest = loadManifest(dir);

    expect(manifest.version).toBe(1);
    expect(manifest.symbols).toEqual([SYMBOL]);
    // candles, htf, snapshots, perp, metrics
    expect(manifest.files).toHaveLength(5);
  });
});

describe('verifyManifest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'load-dataset-'));
    await buildFixtureDataset(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports ok for an untouched export', async () => {
    const result = await verifyManifest(dir);

    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  it('reports the tampered path after changing one byte in a file', async () => {
    const candlePath = join(dir, 'candles', SYMBOL, `${INTERVAL}.jsonl.gz`);
    appendFileSync(candlePath, Buffer.from([0x00]));

    const result = await verifyManifest(dir);

    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain(`candles/${SYMBOL}/${INTERVAL}.jsonl.gz`);
  });
});

describe('lockbox', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'load-dataset-'));
    await buildFixtureDataset(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('drops candle rows at or after the lockbox by default and reports droppedRows', () => {
    const result = loadCandles(dir, SYMBOL, INTERVAL);

    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.t < LOCKBOX_START)).toBe(true);
    expect(result.lockboxApplied).toBe(true);
    expect(result.lockboxStart).toBe(LOCKBOX_START);
    expect(result.droppedRows).toBe(2);
  });

  it('keeps every row when allowLockbox is true', () => {
    const result = loadCandles(dir, SYMBOL, INTERVAL, { allowLockbox: true });

    expect(result.rows).toHaveLength(4);
    expect(result.lockboxApplied).toBe(false);
    expect(result.droppedRows).toBe(0);
  });

  it('applies the same cut to snapshots', () => {
    const result = loadSnapshots(dir, SYMBOL, INTERVAL);

    expect(result.rows).toHaveLength(2);
    expect(result.droppedRows).toBe(2);
  });

  it('keeps candles and htf index-aligned after the cut', () => {
    const candles = loadCandles(dir, SYMBOL, INTERVAL);
    const htf = loadHtf(dir, SYMBOL, INTERVAL);

    expect(htf.rows.map((r) => r.t)).toEqual(candles.rows.map((r) => r.t));
    expect(htf.droppedRows).toBe(candles.droppedRows);
  });
});

describe('perp and metrics kinds', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'load-dataset-'));
    await buildFixtureDataset(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads perpetual bars with their quote volume and trade count', () => {
    const result = loadPerp(dir, SYMBOL, INTERVAL);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].c).toBe(200.5);
    expect(result.rows[0].qv).toBe(2000);
    expect(result.rows[0].n).toBe(5);
  });

  it('defaults to the traded series and keeps the bare interval file name', () => {
    expect(loadPerp(dir, SYMBOL, INTERVAL).rows).toEqual(
      loadPerp(dir, SYMBOL, INTERVAL, 'klines').rows
    );
  });

  it('looks for a non-traded series under its own suffixed file', () => {
    expect(() => loadPerp(dir, SYMBOL, INTERVAL, 'premiumIndex')).toThrow(
      /premiumIndex\.jsonl\.gz/
    );
  });

  it('loads the 5m metrics grid for a symbol, with no interval argument', () => {
    const result = loadMetrics(dir, SYMBOL);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].openInterest).toBe(1000);
    expect(result.rows[0].globalAccountRatio).toBe(1);
  });

  it('keeps a missing measure null rather than zero', () => {
    const result = loadMetrics(dir, SYMBOL);
    expect(result.rows[0].takerLongShortRatio).toBeNull();
    expect(result.rows[0].depthImbalance1).toBeNull();
  });

  it('applies the lockbox to both new kinds exactly as to candles', () => {
    const perp = loadPerp(dir, SYMBOL, INTERVAL);
    const metrics = loadMetrics(dir, SYMBOL);
    expect(perp.lockboxApplied).toBe(true);
    expect(perp.droppedRows).toBe(2);
    expect(metrics.lockboxApplied).toBe(true);
    expect(metrics.droppedRows).toBe(2);
    expect(perp.rows.every((r) => r.t < LOCKBOX_START)).toBe(true);
    expect(metrics.rows.every((r) => r.t < LOCKBOX_START)).toBe(true);
  });

  it('keeps every row for both kinds when allowLockbox is set', () => {
    expect(loadPerp(dir, SYMBOL, INTERVAL, 'klines', { allowLockbox: true }).rows).toHaveLength(4);
    expect(loadMetrics(dir, SYMBOL, { allowLockbox: true }).rows).toHaveLength(4);
  });

  it('verifies with the new files in the manifest', async () => {
    const result = await verifyManifest(dir);
    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  it('reports a tampered metrics file', async () => {
    writeFileSync(join(dir, 'metrics', SYMBOL, '5m.jsonl.gz'), 'tampered');
    const result = await verifyManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain(`metrics/${SYMBOL}/5m.jsonl.gz`);
  });
});
