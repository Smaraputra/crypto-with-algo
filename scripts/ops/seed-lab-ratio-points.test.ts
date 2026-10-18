import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseArgs, seedLabRatioPoints } from './seed-lab-ratio-points';
import { storeRatioPoints } from '@/lib/models/lab-ratio-point';

vi.mock('@/lib/models/lab-ratio-point', () => ({
  storeRatioPoints: vi.fn(),
}));

describe('seed-lab-ratio-points', () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
  });

  it('parses a small snapshot file and calls storeRatioPoints once per symbol with the right points', async () => {
    const mockStore = vi.mocked(storeRatioPoints);
    mockStore.mockResolvedValueOnce(2); // 2 inserted for BTCUSDT
    mockStore.mockResolvedValueOnce(1); // 1 inserted for ETHUSDT

    const snapshot = {
      fetchedAt: '2026-10-18T16:00:00.000Z',
      period: '4h',
      points: {
        BTCUSDT: [
          { timestamp: 1_000_000, longShortRatio: 1.25, longAccount: 0.55, shortAccount: 0.45 },
          { timestamp: 2_000_000, longShortRatio: 1.30, longAccount: 0.56, shortAccount: 0.44 },
        ],
        ETHUSDT: [
          { timestamp: 1_000_000, longShortRatio: 0.95, longAccount: 0.48, shortAccount: 0.52 },
        ],
      },
    };

    const filePath = path.join(tempDir, 'snapshot.json');
    fs.writeFileSync(filePath, JSON.stringify(snapshot), 'utf8');

    const logs: string[] = [];
    const results = await seedLabRatioPoints(filePath, (line) => logs.push(line));

    expect(mockStore).toHaveBeenCalledTimes(2);

    expect(mockStore).toHaveBeenNthCalledWith(
      1,
      'BTCUSDT',
      '4h',
      [
        { timestamp: 1_000_000, longShortRatio: 1.25 },
        { timestamp: 2_000_000, longShortRatio: 1.30 },
      ],
      new Date('2026-10-18T16:00:00.000Z')
    );

    expect(mockStore).toHaveBeenNthCalledWith(
      2,
      'ETHUSDT',
      '4h',
      [
        { timestamp: 1_000_000, longShortRatio: 0.95 },
      ],
      new Date('2026-10-18T16:00:00.000Z')
    );

    expect(results).toEqual([
      { symbol: 'BTCUSDT', inserted: 2, alreadyPresent: 0 },
      { symbol: 'ETHUSDT', inserted: 1, alreadyPresent: 0 },
    ]);

    expect(logs).toEqual([
      'BTCUSDT: 2 inserted, 0 already present',
      'ETHUSDT: 1 inserted, 0 already present',
    ]);
  });

  it('correctly reports already present counts when points already exist in DB', async () => {
    const mockStore = vi.mocked(storeRatioPoints);
    mockStore.mockResolvedValueOnce(1); // 1 inserted out of 3, so 2 already present

    const snapshot = {
      fetchedAt: '2026-10-18T16:00:00.000Z',
      period: '4h',
      points: {
        SOLUSDT: [
          { timestamp: 1_000_000, longShortRatio: 1.1 },
          { timestamp: 2_000_000, longShortRatio: 1.2 },
          { timestamp: 3_000_000, longShortRatio: 1.3 },
        ],
      },
    };

    const filePath = path.join(tempDir, 'snapshot-dup.json');
    fs.writeFileSync(filePath, JSON.stringify(snapshot), 'utf8');

    const logs: string[] = [];
    const results = await seedLabRatioPoints(filePath, (line) => logs.push(line));

    expect(results).toEqual([
      { symbol: 'SOLUSDT', inserted: 1, alreadyPresent: 2 },
    ]);
    expect(logs).toContain('SOLUSDT: 1 inserted, 2 already present');
  });

  it('validates snapshot schema (missing fetchedAt or unsupported period)', async () => {
    const badPeriodPath = path.join(tempDir, 'bad-period.json');
    fs.writeFileSync(badPeriodPath, JSON.stringify({ fetchedAt: '2026-10-18T16:00:00.000Z', period: '1h', points: {} }));
    await expect(seedLabRatioPoints(badPeriodPath)).rejects.toThrow('unsupported period 1h, expected 4h');

    const badDatePath = path.join(tempDir, 'bad-date.json');
    fs.writeFileSync(badDatePath, JSON.stringify({ fetchedAt: 'not-a-date', period: '4h', points: {} }));
    await expect(seedLabRatioPoints(badDatePath)).rejects.toThrow('invalid fetchedAt date');
  });

  it('parseArgs parses --file and optional --mongo-uri', () => {
    const parsed = parseArgs(['--file', 'test.json', '--mongo-uri', 'mongodb://localhost:27017']);
    expect(parsed).toEqual({
      file: 'test.json',
      mongoUri: 'mongodb://localhost:27017',
    });
  });

  it('parseArgs throws on missing --file or unknown arguments', () => {
    expect(() => parseArgs([])).toThrow('--file is required');
    expect(() => parseArgs(['--file'])).toThrow('--file needs a value');
    expect(() => parseArgs(['--file', 'test.json', '--unknown'])).toThrow('unknown argument --unknown');
  });
});
