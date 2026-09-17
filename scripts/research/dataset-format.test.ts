// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LOCKBOX_START,
  LOCKBOX_START_ISO,
  datasetHashOf,
  readJsonlGz,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type ManifestFile,
} from './dataset-format';

describe('LOCKBOX_START', () => {
  it('is 2026-07-01T00:00:00.000Z UTC', () => {
    expect(LOCKBOX_START).toBe(Date.UTC(2026, 6, 1));
    expect(LOCKBOX_START_ISO).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('writeJsonlGz / readJsonlGz', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dataset-format-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips rows through gzip newline-delimited JSON, creating parent dirs', async () => {
    const path = join(dir, 'nested', 'deeper', 'candles.jsonl.gz');
    const rows: CandleRow[] = [
      { t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 100, tbv: 40 },
      { t: 2, o: 1.5, h: 2.5, l: 1, c: 2, v: 200, tbv: null },
    ];

    await writeJsonlGz(path, rows);
    const readBack = readJsonlGz<CandleRow>(path);

    expect(readBack).toEqual(rows);
  });

  it('round-trips an empty row set', async () => {
    const path = join(dir, 'empty.jsonl.gz');

    await writeJsonlGz(path, []);

    expect(readJsonlGz(path)).toEqual([]);
  });
});

describe('sha256File', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sha256-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches the known sha256 of a file\'s contents', async () => {
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'hello world');

    const hash = await sha256File(path);

    expect(hash).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    );
  });
});

describe('datasetHashOf', () => {
  const fileA: ManifestFile = {
    path: 'candles/BTCUSDT/1h.jsonl.gz',
    kind: 'candles',
    symbol: 'BTCUSDT',
    interval: '1h',
    rowCount: 1,
    startMs: 1,
    endMs: 1,
    sha256: 'bbb',
  };
  const fileB: ManifestFile = {
    ...fileA,
    path: 'candles/ETHUSDT/1h.jsonl.gz',
    symbol: 'ETHUSDT',
    sha256: 'aaa',
  };

  it('is deterministic regardless of input order', () => {
    expect(datasetHashOf([fileA, fileB])).toBe(datasetHashOf([fileB, fileA]));
  });

  it('changes when any file hash changes', () => {
    const tampered: ManifestFile = { ...fileB, sha256: 'zzz' };

    expect(datasetHashOf([fileA, fileB])).not.toBe(
      datasetHashOf([fileA, tampered])
    );
  });
});
