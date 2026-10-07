// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LOCKBOX_START,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type DatasetKind,
  type ManifestFile,
} from './dataset-format';
import { DAY_MS, type EventStudyConfig } from './event-studies';
import { syntheticDataset } from './event-studies-synthetic';
import { formatEventStudies, parseArgs, requiredFiles, runEventStudiesHarness } from './event-studies-harness';

const S = Date.UTC(2025, 0, 1);
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const CONFIG: EventStudyConfig = {
  symbols: SYMBOLS,
  sampleStart: S,
  sampleEnd: S + 30 * DAY_MS,
  periods: [0, 10, 20, 25].map((d, i, all) => ({
    label: `P${i + 1}`,
    from: S + d * DAY_MS,
    to: S + (all[i + 1] ?? 30) * DAY_MS,
  })),
  stressFrom: S,
  stressTo: S + 30 * DAY_MS,
};

/** Writes the three kinds per symbol and a manifest whose hashes are real, as export-dataset.ts would. */
async function writeDataset(dir: string, symbols: readonly string[]): Promise<void> {
  const data = syntheticDataset(symbols, {
    from: S - 90 * DAY_MS,
    to: S + 30 * DAY_MS,
    seed: 5,
    metricsMinutes: [0, 55],
    fundingEveryHours: 4,
  });
  const files: ManifestFile[] = [];
  const add = async <T extends { t: number }>(path: string, kind: DatasetKind, symbol: string, interval: string, rows: T[]) => {
    await writeJsonlGz(join(dir, path), rows);
    files.push({
      path,
      kind,
      symbol,
      interval,
      rowCount: rows.length,
      startMs: rows[0]?.t ?? null,
      endMs: rows[rows.length - 1]?.t ?? null,
      sha256: await sha256File(join(dir, path)),
    });
  };
  for (const d of data) {
    const [perp, metrics, funding] = requiredFiles(d.symbol);
    await add(perp, 'perp', d.symbol, '1h', d.klines);
    await add(metrics, 'metrics', d.symbol, '5m', d.metrics);
    await add(funding, 'funding', d.symbol, 'settlements', d.funding);
  }
  const manifest = {
    version: 1,
    generatedAt: '2026-10-08T00:00:00.000Z',
    commit: 'test',
    lockboxStart: new Date(LOCKBOX_START).toISOString(),
    symbols: [...symbols],
    intervals: ['1h', '5m', 'settlements'],
    files,
    datasetHash: datasetHashOf(files),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

describe('parseArgs', () => {
  it('requires --dataset-dir and defaults the task id and output path', () => {
    expect(() => parseArgs([])).toThrow(/--dataset-dir is required/);
    expect(parseArgs(['--dataset-dir', 'data/research-events'])).toEqual({
      datasetDir: 'data/research-events',
      out: 'data/research/reports/event-studies-event-studies.json',
      taskId: 'event-studies',
    });
    expect(parseArgs(['--dataset-dir', 'd', '--task-id', 't2', '--out', 'o.json'])).toEqual({
      datasetDir: 'd',
      out: 'o.json',
      taskId: 't2',
    });
  });

  it('rejects an unknown flag, a stray argument and a missing value', () => {
    expect(() => parseArgs(['--dataset-dir', 'd', '--symbols', 'BTCUSDT'])).toThrow(/Unknown flag --symbols/);
    expect(() => parseArgs(['d'])).toThrow(/Unexpected argument/);
    expect(() => parseArgs(['--dataset-dir'])).toThrow(/Missing value/);
  });
});

describe('runEventStudiesHarness, end to end on a synthetic dataset directory', () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'event-studies-'));
    await writeDataset(dir, SYMBOLS);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('verifies, loads, runs and writes a schema-valid report', async () => {
    const report = await runEventStudiesHarness({ datasetDir: dir, out: '/dev/null', taskId: 'synthetic' }, CONFIG);
    expect(report.taskId).toBe('synthetic');
    expect(report.lockboxApplied).toBe(true);
    expect(report.symbols).toEqual(SYMBOLS);
    expect(report.cells).toHaveLength(9);
    expect(Object.keys(report.coverage)).toEqual(SYMBOLS);
    expect(report.coverage.BTCUSDT.sampleHours).toBe(30 * 24);
    expect(report.coverage.BTCUSDT.validHours).toBe(30 * 24);
    expect(report.volatility.stress?.symbol).toBe('BTCUSDT');
    expect(formatEventStudies(report)).toContain('VERDICT');
  }, 60_000);

  it('refuses a dataset whose files no longer match the manifest', async () => {
    const tampered = mkdtempSync(join(tmpdir(), 'event-studies-tampered-'));
    try {
      await writeDataset(tampered, SYMBOLS);
      appendFileSync(join(tampered, 'funding/ETHUSDT/settlements.jsonl.gz'), 'x');
      await expect(
        runEventStudiesHarness({ datasetDir: tampered, out: '/dev/null', taskId: 't' }, CONFIG)
      ).rejects.toThrow(/verification failed for: funding\/ETHUSDT\/settlements.jsonl.gz/);
    } finally {
      rmSync(tampered, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a dataset whose manifest does not list a file the study reads', async () => {
    await expect(
      runEventStudiesHarness(
        { datasetDir: dir, out: '/dev/null', taskId: 't' },
        { ...CONFIG, symbols: [...SYMBOLS, 'DOGEUSDT'] }
      )
    ).rejects.toThrow(/does not list: perp\/DOGEUSDT\/1h.jsonl.gz/);
  });
});
