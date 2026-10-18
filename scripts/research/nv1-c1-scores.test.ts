// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import type { CandleRow } from './dataset-format';
import { computeFactorMatrix } from './factors';
import {
  assertHoldoutAllowed,
  c1Cutoff,
  c1Scores,
  parseArgs,
  HOLDOUT_GUARD_MESSAGE,
} from './nv1-c1-scores';

function makeSyntheticCandles(seed = 42, count = 600): CandleRow[] {
  const rand = createSeededRandom(seed);
  const rows: CandleRow[] = [];
  const startMs = Date.UTC(2022, 0, 1);
  const stepMs = 3_600_000;
  let price = 100;

  for (let i = 0; i < count; i++) {
    const ret = (rand() - 0.5) * 0.02;
    const open = price;
    const close = price * (1 + ret);
    const high = Math.max(open, close) * 1.002;
    const low = Math.min(open, close) * 0.998;
    const volume = 1000 + rand() * 500;
    const tbv = volume * (0.4 + rand() * 0.2);

    rows.push({
      t: startMs + i * stepMs,
      o: open,
      h: high,
      l: low,
      c: close,
      v: volume,
      tbv,
    });
    price = close;
  }

  return rows;
}

describe('c1Scores', () => {
  it('returns arrays the same length as input, NaN before warmup and finite after, and is deterministic', () => {
    const candles = makeSyntheticCandles(12345, 600);
    const result1 = c1Scores(candles);

    expect(result1.t.length).toBe(600);
    expect(result1.close.length).toBe(600);
    expect(result1.score.length).toBe(600);

    const firstFinite = result1.score.findIndex((s) => Number.isFinite(s));
    expect(firstFinite).toBeGreaterThan(0);
    expect(firstFinite).toBeLessThan(600);

    for (let i = 0; i < firstFinite; i++) {
      expect(Number.isNaN(result1.score[i])).toBe(true);
    }

    for (let i = firstFinite; i < 600; i++) {
      expect(Number.isFinite(result1.score[i])).toBe(true);
    }

    const result2 = c1Scores(candles);
    expect(result2).toEqual(result1);
  });

  it('matches computeFactorMatrix called directly with null-context htf and snapshots null', () => {
    const candles = makeSyntheticCandles(99999, 600);
    const scored = c1Scores(candles);

    const direct = computeFactorMatrix({
      candles,
      snapshots: null,
      htf: candles.map((c) => ({ t: c.t, context: null })),
      interval: '1h',
      style: 'day_trading',
    });

    const compIdx = direct.names.indexOf('composite');
    expect(compIdx).toBeGreaterThanOrEqual(0);

    const directScore = Array.from(direct.values[compIdx]);
    expect(scored.score.length).toBe(directScore.length);

    for (let i = 0; i < directScore.length; i++) {
      if (Number.isNaN(directScore[i])) {
        expect(Number.isNaN(scored.score[i])).toBe(true);
      } else {
        expect(scored.score[i]).toBe(directScore[i]);
      }
    }
  });

  it('handles empty candles array', () => {
    const emptyResult = c1Scores([]);
    expect(emptyResult).toEqual({ t: [], close: [], score: [] });
  });
});

describe('c1Cutoff', () => {
  it('filters rows inside segments, ignores NaN, and matches hand-computed type-7 quantile', () => {
    const seg1 = { start: 1000, end: 2000 };
    const seg2 = { start: 5000, end: 6000 };

    const rows = [
      { t: 999, score: 9999 },
      { t: 1000, score: 10 },
      { t: 1100, score: -20 },
      { t: 1200, score: Number.NaN },
      { t: 1300, score: 30 },
      { t: 1400, score: -40 },
      { t: 1500, score: 50 },
      { t: 2000, score: 9999 },
      { t: 3000, score: 9999 },
      { t: 5000, score: 60 },
      { t: 5100, score: -70 },
      { t: 5200, score: 80 },
      { t: 5300, score: -90 },
      { t: 5400, score: 100 },
      { t: 5500, score: 110 },
      { t: 6000, score: 9999 },
      { t: 7000, score: 9999 },
    ];

    const cutoff = c1Cutoff(rows, [seg1, seg2]);
    expect(cutoff).toBe(100);
  });

  it('computes interpolated type-7 quantile when index is fractional', () => {
    const seg = { start: 100, end: 200 };
    const rows = [
      { t: 110, score: 10 },
      { t: 120, score: 20 },
      { t: 130, score: 30 },
      { t: 140, score: 40 },
      { t: 150, score: 50 },
    ];

    const cutoff = c1Cutoff(rows, [seg]);
    expect(cutoff).toBe(46);
  });

  it('returns NaN when no rows fall within segments or are finite', () => {
    const seg = { start: 100, end: 200 };
    expect(c1Cutoff([], [seg])).toBeNaN();
    expect(c1Cutoff([{ t: 50, score: 10 }], [seg])).toBeNaN();
    expect(c1Cutoff([{ t: 110, score: Number.NaN }], [seg])).toBeNaN();
  });
});

describe('assertHoldoutAllowed', () => {
  it('throws exact message when next-version-v1.ts is absent and passes when present', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nv1-guard-test-'));
    try {
      expect(() => assertHoldoutAllowed(tempDir)).toThrow(HOLDOUT_GUARD_MESSAGE);

      writeFileSync(join(tempDir, 'next-version-v1.ts'), '// Round 1 lock file\n');
      expect(() => assertHoldoutAllowed(tempDir)).not.toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('parseArgs', () => {
  it('parses scores command flags', () => {
    const args = parseArgs([
      'scores',
      '--dataset-dir',
      '/tmp/dataset',
      '--out',
      '/tmp/out.jsonl.gz',
      '--holdout',
    ]);
    expect(args).toEqual({
      command: 'scores',
      datasetDir: '/tmp/dataset',
      out: '/tmp/out.jsonl.gz',
      holdout: true,
    });
  });

  it('parses cutoff command flags', () => {
    const args = parseArgs(['cutoff', '--scores', '/tmp/scores.jsonl.gz']);
    expect(args).toEqual({
      command: 'cutoff',
      scores: '/tmp/scores.jsonl.gz',
    });
  });

  it('throws for unknown command or missing required flags', () => {
    expect(() => parseArgs([])).toThrow(/No command specified/);
    expect(() => parseArgs(['unknown'])).toThrow(/Unknown command/);
    expect(() => parseArgs(['scores', '--dataset-dir', '/tmp/ds'])).toThrow(/--out is required/);
    expect(() => parseArgs(['cutoff'])).toThrow(/--scores is required/);
  });
});
