// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  HOLDOUT_A,
  LOCKBOX_START,
  LOCKBOX_START_ISO,
  datasetHashOf,
  holdoutAEnd,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type HtfRow,
  type ManifestFile,
  type MetricsRow,
  type OptionsRow,
  type PerpCandleRow,
  type SnapshotRow,
} from './dataset-format';
import {
  loadCandles,
  loadHtf,
  loadManifest,
  loadMetrics,
  loadOptions,
  loadFunding,
  loadPerp,
  loadSnapshots,
  parseJsonlGz,
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
  const optionsRows: OptionsRow[] = TIMESTAMPS.map((t, i) => ({
    t,
    dvolOpen: 60 + i,
    dvolHigh: 61 + i,
    dvolLow: 59 + i,
    dvolClose: 60.5 + i,
    callBuyNotional: 1_000_000 + i,
    callSellNotional: null,
    putBuyNotional: null,
    putSellNotional: 500_000 + i,
    netDelta: 10 + i,
    netDollarGamma: null,
    tradeCount: 42 + i,
    greekTradeCount: null,
    vwIv: 65 + i,
    putIv25: null,
    callIv25: null,
  }));

  const candlePath = join(dir, 'candles', SYMBOL, `${INTERVAL}.jsonl.gz`);
  const perpPath = join(dir, 'perp', SYMBOL, `${INTERVAL}.jsonl.gz`);
  const metricsPath = join(dir, 'metrics', SYMBOL, '5m.jsonl.gz');
  const htfPath = join(dir, 'htf', SYMBOL, `${INTERVAL}.jsonl.gz`);
  const snapshotPath = join(dir, 'snapshots', SYMBOL, `${INTERVAL}.jsonl.gz`);
  const optionsPath = join(dir, 'options', 'BTC', '1h.jsonl.gz');

  await writeJsonlGz(candlePath, candleRows);
  await writeJsonlGz(htfPath, htfRows);
  await writeJsonlGz(snapshotPath, snapshotRows);
  await writeJsonlGz(perpPath, perpRows);
  await writeJsonlGz(metricsPath, metricsRows);
  await writeJsonlGz(optionsPath, optionsRows);

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
    {
      // Recorded under the USDT symbol, per the pitfall in the brief:
      // manifest.symbols is the union of the files' symbol fields, and
      // factor-ic.ts uses it as the default universe.
      path: 'options/BTC/1h.jsonl.gz',
      kind: 'options',
      symbol: SYMBOL,
      interval: '1h',
      rowCount: optionsRows.length,
      startMs: optionsRows[0].t,
      endMs: optionsRows[optionsRows.length - 1].t,
      sha256: await sha256File(optionsPath),
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
    // candles, htf, snapshots, perp, metrics, options
    expect(manifest.files).toHaveLength(6);
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

describe('options kind', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'load-dataset-'));
    await buildFixtureDataset(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the hourly options series for a currency, with no interval argument', () => {
    const result = loadOptions(dir, 'BTC');
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].dvolClose).toBe(60.5);
    expect(result.rows[0].tradeCount).toBe(42);
  });

  it('keeps a missing measure null rather than zero', () => {
    const result = loadOptions(dir, 'BTC');
    expect(result.rows[0].callSellNotional).toBeNull();
    expect(result.rows[0].putBuyNotional).toBeNull();
    expect(result.rows[0].netDollarGamma).toBeNull();
    expect(result.rows[0].greekTradeCount).toBeNull();
  });

  it('applies the lockbox exactly as the other kinds', () => {
    const result = loadOptions(dir, 'BTC');
    expect(result.lockboxApplied).toBe(true);
    expect(result.droppedRows).toBe(2);
    expect(result.rows.every((r) => r.t < LOCKBOX_START)).toBe(true);
  });

  it('keeps every row when allowLockbox is set', () => {
    expect(loadOptions(dir, 'BTC', { allowLockbox: true }).rows).toHaveLength(4);
  });

  it('records the options file under the USDT symbol, so manifest.symbols gains no currency', () => {
    const manifest = loadManifest(dir);
    const optionsFile = manifest.files.find((f) => f.kind === 'options')!;
    expect(optionsFile.symbol).toBe(SYMBOL);
    expect(optionsFile.path).toBe('options/BTC/1h.jsonl.gz');
    expect(manifest.symbols).toEqual([SYMBOL]);
  });

  it('verifies with the options file in the manifest', async () => {
    const result = await verifyManifest(dir);
    expect(result).toEqual({ ok: true, mismatches: [] });
  });

  it('reports a tampered options file', async () => {
    writeFileSync(join(dir, 'options', 'BTC', '1h.jsonl.gz'), 'tampered');
    const result = await verifyManifest(dir);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toContain('options/BTC/1h.jsonl.gz');
  });
});

describe('loadFunding', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'load-dataset-funding-'));
    const EIGHT_H = 8 * HOUR;
    await writeJsonlGz(join(dir, 'funding', SYMBOL, 'settlements.jsonl.gz'), [
      { t: LOCKBOX_START - 2 * EIGHT_H, rate: 0.0001, intervalHours: 8 },
      { t: LOCKBOX_START - EIGHT_H, rate: 0.00012, intervalHours: 8 },
      { t: LOCKBOX_START, rate: 0.0002, intervalHours: 8 },
    ]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads one row per settlement and applies the lockbox to the settlement time', () => {
    const result = loadFunding(dir, SYMBOL);
    expect(result.rows.map((r) => r.rate)).toEqual([0.0001, 0.00012]);
    expect(result.droppedRows).toBe(1);
    expect(result.rows[0].intervalHours).toBe(8);
  });

  it('keeps the lockbox settlement when allowLockbox is true', () => {
    expect(loadFunding(dir, SYMBOL, { allowLockbox: true }).rows).toHaveLength(3);
  });
});

describe('parseJsonlGz (parse the very bytes a caller hashed)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'load-dataset-buffer-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a gzipped JSON-lines buffer into the same rows the path reader returns, with no lockbox applied', async () => {
    const path = join(dir, 'funding', SYMBOL, 'settlements.jsonl.gz');
    const rows = [
      { t: LOCKBOX_START - 8 * HOUR, rate: 0.0001, intervalHours: 8 },
      { t: LOCKBOX_START, rate: 0.0002, intervalHours: null },
    ];
    await writeJsonlGz(path, rows);
    expect(parseJsonlGz(readFileSync(path))).toEqual(rows);
    expect(parseJsonlGz(readFileSync(path))).toEqual(loadFunding(dir, SYMBOL, { allowLockbox: true }).rows);
  });
});

describe('holdout segment A', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'load-dataset-holdout-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('holdoutAEnd boundaries', () => {
    it('returns 2021-10-14 for spot intraday cadences', () => {
      const expected = Date.UTC(2021, 9, 14);
      expect(holdoutAEnd('spot', '1h')).toBe(expected);
      expect(holdoutAEnd('spot', '15m')).toBe(expected);
      expect(holdoutAEnd('spot', '5m')).toBe(expected);
    });

    it('returns 2018-10-31 for spot daily and higher cadences', () => {
      const expected = Date.UTC(2018, 9, 31);
      expect(holdoutAEnd('spot', '4h')).toBe(expected);
      expect(holdoutAEnd('spot', '1d')).toBe(expected);
    });

    it('returns 2022-01-01 for perp intraday cadences', () => {
      const expected = Date.UTC(2022, 0, 1);
      expect(holdoutAEnd('perp', '5m')).toBe(expected);
      expect(holdoutAEnd('perp', '4h')).toBe(expected);
    });

    it('returns 2020-01-01 for perp daily cadences', () => {
      const expected = Date.UTC(2020, 0, 1);
      expect(holdoutAEnd('perp', '1d')).toBe(expected);
    });

    it('throws on unknown intervals', () => {
      expect(() => holdoutAEnd('spot', '7m')).toThrow('holdoutAEnd: unknown interval 7m');
    });
  });

  it('loadCandles on a 1h fixture drops rows before 2021-10-14 by default and keeps them with allowHoldoutA', async () => {
    const tBefore = Date.UTC(2021, 9, 13, 23, 0);
    const tAfter = Date.UTC(2021, 9, 14, 0, 0);
    const candlePath = join(dir, 'candles', SYMBOL, '1h.jsonl.gz');
    const rows: CandleRow[] = [
      { t: tBefore, o: 100, h: 101, l: 99, c: 100.5, v: 10, tbv: null },
      { t: tAfter, o: 101, h: 102, l: 100, c: 101.5, v: 12, tbv: null },
    ];
    await writeJsonlGz(candlePath, rows);

    const defaultResult = loadCandles(dir, SYMBOL, '1h');
    expect(defaultResult.rows).toHaveLength(1);
    expect(defaultResult.rows[0].t).toBe(tAfter);
    expect(defaultResult.holdoutDroppedRows).toBe(1);
    expect(defaultResult.holdoutAApplied).toBe(true);
    expect(defaultResult.holdoutAEnd).toBe(HOLDOUT_A.spotIntradayEnd);

    const allowedResult = loadCandles(dir, SYMBOL, '1h', { allowHoldoutA: true });
    expect(allowedResult.rows).toHaveLength(2);
    expect(allowedResult.holdoutDroppedRows).toBe(0);
    expect(allowedResult.holdoutAApplied).toBe(false);
    expect(allowedResult.holdoutAEnd).toBe(HOLDOUT_A.spotIntradayEnd);
  });

  it('loadCandles on a 1d fixture keeps only rows from 2018-10-31 onward by default', async () => {
    const tBefore = Date.UTC(2018, 9, 30);
    const tAfter = Date.UTC(2018, 9, 31);
    const candlePath = join(dir, 'candles', SYMBOL, '1d.jsonl.gz');
    const rows: CandleRow[] = [
      { t: tBefore, o: 100, h: 101, l: 99, c: 100.5, v: 10, tbv: null },
      { t: tAfter, o: 101, h: 102, l: 100, c: 101.5, v: 12, tbv: null },
    ];
    await writeJsonlGz(candlePath, rows);

    const result = loadCandles(dir, SYMBOL, '1d');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].t).toBe(tAfter);
    expect(result.holdoutDroppedRows).toBe(1);
    expect(result.holdoutAApplied).toBe(true);
  });

  it('loadPerp drops rows before 2022-01-01 for 1h and before 2020-01-01 for 1d', async () => {
    const perp1h = join(dir, 'perp', SYMBOL, '1h.jsonl.gz');
    const tPerp1hBefore = Date.UTC(2021, 11, 31, 23, 0);
    const tPerp1hAfter = Date.UTC(2022, 0, 1, 0, 0);
    const rows1h: PerpCandleRow[] = [
      { t: tPerp1hBefore, o: 200, h: 201, l: 199, c: 200.5, v: 20, qv: 2000, n: 5, tbv: null },
      { t: tPerp1hAfter, o: 201, h: 202, l: 200, c: 201.5, v: 22, qv: 2200, n: 6, tbv: null },
    ];
    await writeJsonlGz(perp1h, rows1h);

    const result1h = loadPerp(dir, SYMBOL, '1h');
    expect(result1h.rows).toHaveLength(1);
    expect(result1h.rows[0].t).toBe(tPerp1hAfter);
    expect(result1h.holdoutDroppedRows).toBe(1);
    expect(result1h.holdoutAApplied).toBe(true);

    const perp1d = join(dir, 'perp', SYMBOL, '1d.jsonl.gz');
    const tPerp1dBefore = Date.UTC(2019, 11, 31);
    const tPerp1dAfter = Date.UTC(2020, 0, 1);
    const rows1d: PerpCandleRow[] = [
      { t: tPerp1dBefore, o: 300, h: 301, l: 299, c: 300.5, v: 30, qv: 3000, n: 7, tbv: null },
      { t: tPerp1dAfter, o: 301, h: 302, l: 300, c: 301.5, v: 32, qv: 3200, n: 8, tbv: null },
    ];
    await writeJsonlGz(perp1d, rows1d);

    const result1d = loadPerp(dir, SYMBOL, '1d');
    expect(result1d.rows).toHaveLength(1);
    expect(result1d.rows[0].t).toBe(tPerp1dAfter);
    expect(result1d.holdoutDroppedRows).toBe(1);
    expect(result1d.holdoutAApplied).toBe(true);
  });

  it('combines holdout and lockbox: default keeps only normal rows while both flags keep all three', async () => {
    const tSegmentA = Date.UTC(2021, 9, 13);
    const tNormal = Date.UTC(2024, 0, 1);
    const tLockbox = Date.UTC(2026, 6, 2);
    const candlePath = join(dir, 'candles', SYMBOL, '1h.jsonl.gz');
    const rows: CandleRow[] = [
      { t: tSegmentA, o: 100, h: 101, l: 99, c: 100.5, v: 10, tbv: null },
      { t: tNormal, o: 101, h: 102, l: 100, c: 101.5, v: 11, tbv: null },
      { t: tLockbox, o: 102, h: 103, l: 101, c: 102.5, v: 12, tbv: null },
    ];
    await writeJsonlGz(candlePath, rows);

    const defaultResult = loadCandles(dir, SYMBOL, '1h');
    expect(defaultResult.rows).toHaveLength(1);
    expect(defaultResult.rows[0].t).toBe(tNormal);
    expect(defaultResult.holdoutDroppedRows).toBe(1);
    expect(defaultResult.holdoutAApplied).toBe(true);
    expect(defaultResult.droppedRows).toBe(1);
    expect(defaultResult.lockboxApplied).toBe(true);

    const bothResult = loadCandles(dir, SYMBOL, '1h', { allowHoldoutA: true, allowLockbox: true });
    expect(bothResult.rows).toHaveLength(3);
    expect(bothResult.holdoutDroppedRows).toBe(0);
    expect(bothResult.holdoutAApplied).toBe(false);
    expect(bothResult.droppedRows).toBe(0);
    expect(bothResult.lockboxApplied).toBe(false);
  });

  it('loadSnapshots and loadFunding drop nothing before 2018 because holdout is not applied', async () => {
    const tOld = Date.UTC(2017, 7, 1);
    const snapPath = join(dir, 'snapshots', SYMBOL, '1h.jsonl.gz');
    const snapshotRows: SnapshotRow[] = [
      {
        t: tOld,
        fundingRate: null,
        longShortRatio: null,
        openInterest: null,
        fearGreed: null,
        newsSentiment: null,
      },
    ];
    await writeJsonlGz(snapPath, snapshotRows);

    const snapResult = loadSnapshots(dir, SYMBOL, '1h');
    expect(snapResult.rows).toHaveLength(1);
    expect(snapResult.rows[0].t).toBe(tOld);
    expect(snapResult.holdoutAApplied).toBe(false);
    expect(snapResult.holdoutAEnd).toBeNull();
    expect(snapResult.holdoutDroppedRows).toBe(0);

    const fundingPath = join(dir, 'funding', SYMBOL, 'settlements.jsonl.gz');
    const fundingRows = [{ t: tOld, rate: 0.0001, intervalHours: 8 }];
    await writeJsonlGz(fundingPath, fundingRows);

    const fundingResult = loadFunding(dir, SYMBOL);
    expect(fundingResult.rows).toHaveLength(1);
    expect(fundingResult.rows[0].t).toBe(tOld);
    expect(fundingResult.holdoutAApplied).toBe(false);
    expect(fundingResult.holdoutAEnd).toBeNull();
    expect(fundingResult.holdoutDroppedRows).toBe(0);
  });
});
