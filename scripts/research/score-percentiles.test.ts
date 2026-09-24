// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TIER_BUY_CUTOFF, TIER_STRONG_CUTOFF } from '@/lib/signals/calibration';
import {
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type HtfRow,
  type ManifestFile,
  type SnapshotRow,
} from './dataset-format';
import type { FactorMatrix } from './factors';
import {
  collectAbsScores,
  formatReport,
  nearestRankPercentile,
  parseArgs,
  runScorePercentiles,
  summarizeAbsScores,
  type ScorePercentilesReport,
} from './score-percentiles';

describe('nearestRankPercentile', () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it('returns the nearest-rank value of an ascending series', () => {
    expect(nearestRankPercentile(oneToHundred, 0.5)).toBe(50);
    expect(nearestRankPercentile(oneToHundred, 0.9)).toBe(90);
    expect(nearestRankPercentile(oneToHundred, 0.98)).toBe(98);
    expect(nearestRankPercentile(oneToHundred, 1)).toBe(100);
  });

  it('returns the only value of a singleton and NaN for an empty series', () => {
    expect(nearestRankPercentile([7], 0.9)).toBe(7);
    expect(nearestRankPercentile([], 0.9)).toBeNaN();
  });
});

describe('summarizeAbsScores', () => {
  it('reports count, percentiles, and the share strictly above each cutoff, as the tiers do', () => {
    const summary = summarizeAbsScores([31, 10, 24, 30, 20, 25], { buy: 24, strong: 30 });

    expect(summary.count).toBe(6);
    expect(summary.p50).toBe(24);
    expect(summary.p90).toBe(31);
    expect(summary.p98).toBe(31);
    // 25, 30, 31 are above 24 (24 itself is neutral); only 31 is above 30.
    expect(summary.shareAboveBuy).toBeCloseTo(3 / 6, 9);
    expect(summary.shareAboveStrong).toBeCloseTo(1 / 6, 9);
  });

  it('returns zero count and NaN percentiles for no scores', () => {
    const summary = summarizeAbsScores([], { buy: 24, strong: 30 });

    expect(summary.count).toBe(0);
    expect(summary.p90).toBeNaN();
    expect(summary.shareAboveBuy).toBeNaN();
  });
});

function fakeMatrix(): FactorMatrix {
  const names = ['composite', 'raw.fundingRate', 'raw.fearGreed'];
  return {
    names,
    categories: ['composite', 'raw', 'raw'],
    values: [
      Float64Array.from([NaN, -30, 12, 8, 40]),
      Float64Array.from([NaN, 0.01, NaN, NaN, NaN]),
      Float64Array.from([NaN, 50, NaN, 60, NaN]),
    ],
    warmupBars: 1,
    timestamps: [0, 1, 2, 3, 4],
    closes: [1, 1, 1, 1, 1],
  };
}

describe('collectAbsScores', () => {
  it('keeps |composite| of post-warmup bars that carry a snapshot, counting the rest', () => {
    const result = collectAbsScores(fakeMatrix(), { requireSnapshot: true });

    expect(result.scores).toEqual([30, 8]);
    expect(result.barsScored).toBe(4);
    expect(result.barsWithoutSnapshot).toBe(2);
    expect(result.firstTimestamp).toBe(1);
    expect(result.lastTimestamp).toBe(3);
  });

  it('keeps every post-warmup bar when a snapshot is not required', () => {
    const result = collectAbsScores(fakeMatrix(), { requireSnapshot: false });

    expect(result.scores).toEqual([30, 12, 8, 40]);
    expect(result.barsWithoutSnapshot).toBe(2);
    expect(result.firstTimestamp).toBe(1);
    expect(result.lastTimestamp).toBe(4);
  });

  it('reports no timestamps when nothing qualifies', () => {
    const matrix = fakeMatrix();
    matrix.values[1].fill(NaN);
    matrix.values[2].fill(NaN);

    const result = collectAbsScores(matrix, { requireSnapshot: true });

    expect(result.scores).toEqual([]);
    expect(result.firstTimestamp).toBeNull();
    expect(result.lastTimestamp).toBeNull();
  });
});

describe('parseArgs', () => {
  it('defaults to the local dataset, every manifest interval and symbol, lockbox applied, snapshot required', () => {
    expect(parseArgs([])).toEqual({
      datasetDir: 'data/research',
      intervals: undefined,
      symbols: undefined,
      allowLockbox: false,
      includeNoSnapshot: false,
      json: false,
    });
  });

  it('parses every flag', () => {
    const args = parseArgs([
      '--dataset-dir', '/tmp/ds',
      '--intervals', '5m,1h',
      '--symbols', 'BTCUSDT, ETHUSDT',
      '--allow-lockbox',
      '--include-no-snapshot',
      '--json',
    ]);

    expect(args).toEqual({
      datasetDir: '/tmp/ds',
      intervals: ['5m', '1h'],
      symbols: ['BTCUSDT', 'ETHUSDT'],
      allowLockbox: true,
      includeNoSnapshot: true,
      json: true,
    });
  });

  it('rejects an unknown flag and a value flag with no value', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown flag --bogus/);
    expect(() => parseArgs(['--intervals'])).toThrow(/Missing value for --intervals/);
  });
});

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const INTERVAL = '1h';
const HOUR = 3_600_000;
const START = Date.UTC(2025, 0, 1);
const COUNT = 600;
const SNAPSHOT_FROM = 300;

function makeRng(seed: number): () => number {
  let state = seed;
  return function next(): number {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function generateCandles(seed: number): CandleRow[] {
  const next = makeRng(seed);
  const rows: CandleRow[] = [];
  let price = 100;
  for (let i = 0; i < COUNT; i++) {
    const ret = (next() - 0.5) * 0.02;
    const open = price;
    const close = price * (1 + ret);
    const high = Math.max(open, close) * 1.001;
    const low = Math.min(open, close) * 0.999;
    const volume = 1000 + next() * 500;
    rows.push({ t: START + i * HOUR, o: open, h: high, l: low, c: close, v: volume, tbv: volume * 0.5 });
    price = close;
  }
  return rows;
}

/** Two symbols, 600 1h bars, snapshots only from bar SNAPSHOT_FROM onward, null-context htf rows. */
async function buildFixtureDataset(dir: string): Promise<DatasetManifest> {
  const files: ManifestFile[] = [];

  for (const [i, symbol] of SYMBOLS.entries()) {
    const candleRows = generateCandles(4242 + i * 1000);
    const snapshotRows: SnapshotRow[] = candleRows.slice(SNAPSHOT_FROM).map((c) => ({
      t: c.t,
      fundingRate: { rate: 0.0001, markPrice: null },
      longShortRatio: null,
      openInterest: null,
      fearGreed: { index: 50, label: 'Neutral' },
      newsSentiment: null,
    }));
    const htfRows: HtfRow[] = candleRows.map((c) => ({ t: c.t, context: null }));

    const rel = (kind: string) => `${kind}/${symbol}/${INTERVAL}.jsonl.gz`;
    await writeJsonlGz(join(dir, rel('candles')), candleRows);
    await writeJsonlGz(join(dir, rel('snapshots')), snapshotRows);
    await writeJsonlGz(join(dir, rel('htf')), htfRows);

    files.push(
      {
        path: rel('candles'), kind: 'candles', symbol, interval: INTERVAL, rowCount: candleRows.length,
        startMs: candleRows[0].t, endMs: candleRows[candleRows.length - 1].t,
        sha256: await sha256File(join(dir, rel('candles'))),
      },
      {
        path: rel('snapshots'), kind: 'snapshots', symbol, interval: INTERVAL, rowCount: snapshotRows.length,
        startMs: snapshotRows[0].t, endMs: snapshotRows[snapshotRows.length - 1].t,
        sha256: await sha256File(join(dir, rel('snapshots'))),
      },
      {
        path: rel('htf'), kind: 'htf', symbol, interval: INTERVAL, rowCount: htfRows.length,
        startMs: htfRows[0].t, endMs: htfRows[htfRows.length - 1].t,
        sha256: await sha256File(join(dir, rel('htf'))),
      }
    );
  }

  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    commit: 'test-fixture',
    lockboxStart: LOCKBOX_START_ISO,
    symbols: SYMBOLS,
    intervals: [INTERVAL],
    files,
    datasetHash: datasetHashOf(files),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe('runScorePercentiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'score-percentiles-'));
    await buildFixtureDataset(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('measures |composite| per symbol and pooled over the bars that carry a snapshot', async () => {
    const report = await runScorePercentiles(parseArgs(['--dataset-dir', dir]));

    expect(report.lockboxApplied).toBe(true);
    expect(report.requireSnapshot).toBe(true);
    // Reads the live calibration, so it must not restate the numbers: they
    // moved from 24/30 to 30/38 when the scorer fixes shifted the distribution.
    expect(report.cutoffs).toEqual({ buy: TIER_BUY_CUTOFF, strong: TIER_STRONG_CUTOFF });
    expect(report.intervals).toHaveLength(1);

    const [block] = report.intervals;
    expect(block.interval).toBe('1h');
    expect(block.style).toBe('day_trading');
    expect(block.symbols.map((s) => s.symbol)).toEqual(SYMBOLS);

    for (const row of block.symbols) {
      // One snapshot per bar from SNAPSHOT_FROM onward, all after the style's warmup.
      expect(row.summary.count).toBe(COUNT - SNAPSHOT_FROM);
      expect(row.barsWithoutSnapshot).toBeGreaterThan(0);
      expect(row.from).toBe(new Date(START + SNAPSHOT_FROM * HOUR).toISOString());
      expect(row.to).toBe(new Date(START + (COUNT - 1) * HOUR).toISOString());
      expect(row.summary.p50).toBeLessThanOrEqual(row.summary.p90);
      expect(row.summary.p90).toBeLessThanOrEqual(row.summary.p98);
      expect(row.summary.p98).toBeLessThanOrEqual(100);
      expect(row.summary.shareAboveStrong).toBeLessThanOrEqual(row.summary.shareAboveBuy);
    }

    expect(block.pooled.count).toBe(SYMBOLS.length * (COUNT - SNAPSHOT_FROM));
    expect(block.barsWithoutSnapshot).toBe(
      block.symbols.reduce((sum, row) => sum + row.barsWithoutSnapshot, 0)
    );
  }, 30_000);

  it('includes the bars without a snapshot when asked, and they score higher on average', async () => {
    const strict = await runScorePercentiles(parseArgs(['--dataset-dir', dir]));
    const loose = await runScorePercentiles(parseArgs(['--dataset-dir', dir, '--include-no-snapshot']));

    expect(loose.requireSnapshot).toBe(false);
    const strictBlock = strict.intervals[0];
    const looseBlock = loose.intervals[0];
    expect(looseBlock.pooled.count).toBe(strictBlock.pooled.count + strictBlock.barsWithoutSnapshot);
    // With futures and sentiment absent their weight is redistributed, which
    // is exactly the compression the calibration header describes.
    expect(looseBlock.pooled.p90).toBeGreaterThanOrEqual(strictBlock.pooled.p90);
  }, 30_000);

  it('rejects a dataset whose manifest does not verify', async () => {
    writeFileSync(join(dir, 'candles', 'BTCUSDT', '1h.jsonl.gz'), 'tampered');

    await expect(runScorePercentiles(parseArgs(['--dataset-dir', dir]))).rejects.toThrow(/verification failed/);
  });
});

describe('formatReport', () => {
  const report: ScorePercentilesReport = {
    generatedAt: '2026-09-19T00:00:00.000Z',
    datasetHash: 'abc',
    commit: 'def',
    lockboxApplied: true,
    requireSnapshot: true,
    cutoffs: { buy: 24, strong: 30 },
    intervals: [
      {
        interval: '1h',
        style: 'day_trading',
        from: '2026-03-04T00:00:00.000Z',
        to: '2026-06-30T23:00:00.000Z',
        barsWithoutSnapshot: 5,
        pooled: { count: 200, p50: 10, p90: 22.5, p98: 29.75, shareAboveBuy: 0.09, shareAboveStrong: 0.02 },
        symbols: [
          {
            symbol: 'BTCUSDT',
            from: '2026-03-04T00:00:00.000Z',
            to: '2026-06-30T23:00:00.000Z',
            barsWithoutSnapshot: 5,
            summary: { count: 200, p50: 10, p90: 22.5, p98: 29.75, shareAboveBuy: 0.09, shareAboveStrong: 0.02 },
          },
        ],
      },
    ],
  };

  it('prints one JSON line per interval with --json', () => {
    const lines = formatReport(report, true).split('\n');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(report.intervals[0]);
  });

  it('prints a header per interval, a pooled row, a row per symbol, and the closing note', () => {
    const output = formatReport(report, false);

    expect(output).toContain('interval=1h style=day_trading symbols=1');
    expect(output).toContain('lockbox=applied snapshot=required');
    expect(output).toContain('range=2026-03-04T00:00:00.000Z..2026-06-30T23:00:00.000Z');
    expect(output).toContain('pooled');
    expect(output).toContain('count=200 p50=10.0 p90=22.5 p98=29.8 above24=0.0900 above30=0.0200');
    expect(output).toContain('BTCUSDT');
    expect(output.trimEnd().endsWith('cutoffs: buy above 24, strong above 30')).toBe(true);
  });
});
