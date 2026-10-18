// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createSeededRandom } from '../../src/lib/stats/seeded-random';
import {
  LOCK_GUARD_MESSAGE,
  NV1_C1,
  assertLockPresent,
  assessable,
  binomialSignTestP,
  calibrate,
  coinSeriesInWindow,
  maxTest,
  observedN,
  sidesFromScores,
  wilsonScoreInterval,
} from './nv1-c1';
import { CoinSeries, NV1_SEGMENTS } from './nv1-core';

describe('sidesFromScores', () => {
  it('converts scores to +1, -1, 0 on hand values including exact cutoff and NaN', () => {
    const c90 = 2.5;
    const scores = [5.0, 2.5, 2.4, 0, -2.4, -2.5, -5.0, Number.NaN];
    const sides = sidesFromScores(scores, c90);
    expect(sides).toEqual([1, 1, 0, 0, 0, -1, -1, 0]);
  });
});

describe('assessable', () => {
  it('checks assessable boundaries on trades and blocks', () => {
    const blockHours = 168;

    // 399 vs 400 trades at 40 blocks
    expect(assessable(399, 40 * blockHours)).toBe(false);
    expect(assessable(400, 40 * blockHours)).toBe(true);

    // 39 vs 40 blocks at 400 trades
    expect(assessable(400, 39 * blockHours)).toBe(false);
    expect(assessable(400, 40 * blockHours)).toBe(true);

    // Fractional block boundary
    expect(assessable(400, 39.9 * blockHours)).toBe(false);
    expect(assessable(400, 40.1 * blockHours)).toBe(true);

    // Both below boundary
    expect(assessable(399, 39 * blockHours)).toBe(false);
  });
});

describe('coinSeriesInWindow', () => {
  it('drops off-grid bars and filters by window [start, end)', () => {
    const start = 1_000 * 3_600_000;
    const end = 1_005 * 3_600_000;
    const rows = [
      { symbol: 'BTCUSDT', t: start - 3_600_000, close: 100, score: 3.0 },
      { symbol: 'BTCUSDT', t: start, close: 101, score: 3.0 },
      { symbol: 'BTCUSDT', t: start + 1_800_000, close: 101.5, score: 3.0 }, // off-grid
      { symbol: 'BTCUSDT', t: start + 3_600_000, close: 102, score: -3.0 },
      { symbol: 'BTCUSDT', t: start + 2 * 3_600_000, close: 103, score: 0.5 },
      { symbol: 'ETHUSDT', t: start + 3 * 3_600_000, close: 200, score: 3.0 }, // wrong symbol
      { symbol: 'BTCUSDT', t: end, close: 104, score: 3.0 }, // at end
    ];

    const series = coinSeriesInWindow(rows, 'BTCUSDT', start, end, 2.0);
    expect(series.symbol).toBe('BTCUSDT');
    expect(series.t).toEqual([start, start + 3_600_000, start + 2 * 3_600_000]);
    expect(series.close).toEqual([101, 102, 103]);
    expect(series.side).toEqual([1, -1, 0]);
  });
});

describe('observedN', () => {
  it('computes pooled net mean and trade count across coins', () => {
    const coin: CoinSeries = {
      symbol: 'BTCUSDT',
      t: [1000, 1000 + NV1_C1.stepMs, 1000 + 2 * NV1_C1.stepMs],
      close: [100, 101, 102],
      side: [0, 0, 0],
    };
    const obs = observedN([coin], 0, 0, 10000);
    expect(obs.trades).toBe(0);
    expect(Number.isNaN(obs.n)).toBe(true);
  });
});

function generatePersistentSides(count: number, rand: () => number): number[] {
  const sides = new Array<number>(count);
  let i = 0;
  let current = rand() < 0.5 ? 1 : -1;
  while (i < count) {
    const run = 26 + Math.floor(rand() * 4);
    for (let r = 0; r < run && i < count; r++, i++) {
      sides[i] = current;
    }
    const pause = 24;
    for (let p = 0; p < pause && i < count; p++, i++) {
      sides[i] = 0;
    }
    current = current === 1 ? -1 : 1;
  }
  return sides;
}

function makeSyntheticCoins(
  count: number,
  bars: number,
  seed: number,
  planted: boolean
): CoinSeries[] {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'XRPUSDT', 'LINKUSDT'].slice(
    0,
    count
  );
  const startMs = Date.UTC(2022, 0, 1);
  const stepMs = NV1_C1.stepMs;
  const rand = createSeededRandom(seed);

  return symbols.map((symbol) => {
    const t = new Array<number>(bars);
    const close = new Array<number>(bars);
    const side = generatePersistentSides(bars, rand);

    let price = 100;
    for (let i = 0; i < bars; i++) {
      t[i] = startMs + i * stepMs;

      if (i === 0) {
        close[i] = price;
      } else {
        const noise = (rand() - 0.5) * 0.002;
        const drift = planted ? side[i - 1] * (0.005 / 24) : 0;
        price = price * (1 + drift + noise);
        close[i] = price;
      }
    }

    return {
      symbol,
      t,
      close,
      side,
    };
  });
}

describe('maxTest', () => {
  const bars = 8_000;
  const from = Date.UTC(2022, 0, 1);
  const to = from + bars * NV1_C1.stepMs;

  it('fails and p > 0.05 on 6 synthetic coins of 8,000 bars with random sides independent of returns', () => {
    const coins = makeSyntheticCoins(6, bars, 42, false);
    const result = maxTest(coins, from, to, 100, 20261018, 200, 20261019);

    expect(result.nK.length).toBe(4);
    expect(result.tradesK.length).toBe(4);
    for (let ki = 0; ki < 4; ki++) {
      expect(result.tradesK[ki]).toBeGreaterThanOrEqual(400);
      expect(result.assessableK[ki]).toBe(true);
    }

    expect(result.pass).toBe(false);
    expect(result.p).toBeGreaterThan(0.05);
  });

  it('passes on the same coins with a planted edge drifting +0.5% / -0.5% per 24 bars', () => {
    const coinsPlanted = makeSyntheticCoins(6, bars, 42, true);
    const result = maxTest(coinsPlanted, from, to, 100, 20261018, 200, 20261019);

    expect(result.maxObs).toBeGreaterThan(result.critical95);
    expect(result.pass).toBe(true);
    expect(result.p).toBeLessThan(0.05);
  });
});

describe('calibrate', () => {
  it('returns rates in [0, 1], E = 0 equals false-pass rate field, and is deterministic for tiny counts', () => {
    const totalBars = Math.floor(
      (NV1_SEGMENTS.C.end - NV1_SEGMENTS.B.start) / NV1_C1.stepMs
    );
    const startMs = NV1_SEGMENTS.B.start;
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const rand = createSeededRandom(999);

    const coinsBC: CoinSeries[] = symbols.map((symbol) => {
      const t = new Array<number>(totalBars);
      const close = new Array<number>(totalBars);
      const side = generatePersistentSides(totalBars, rand);

      let price = 100;
      for (let i = 0; i < totalBars; i++) {
        t[i] = startMs + i * NV1_C1.stepMs;
        if (i === 0) {
          close[i] = price;
        } else {
          price = price * (1 + (rand() - 0.5) * 0.002);
          close[i] = price;
        }
      }

      return { symbol, t, close, side };
    });

    const replays = 3;
    const seedBase = 20261100;
    const stdDraws = 20;
    const nullDraws = 40;
    const edges = [0, 0.1, 0.2, 0.3];

    const result1 = calibrate(coinsBC, replays, seedBase, stdDraws, nullDraws, edges);

    expect(result1.replays).toBe(replays);
    expect(result1.falsePassRate).toBeGreaterThanOrEqual(0);
    expect(result1.falsePassRate).toBeLessThanOrEqual(1);

    const edge0 = result1.edges.find((e) => e.edge === 0);
    expect(edge0).toBeDefined();
    expect(edge0!.passRate).toBe(result1.falsePassRate);

    for (const e of result1.edges) {
      expect(e.passRate).toBeGreaterThanOrEqual(0);
      expect(e.passRate).toBeLessThanOrEqual(1);
      expect(e.wilson95[0]).toBeGreaterThanOrEqual(0);
      expect(e.wilson95[1]).toBeLessThanOrEqual(1);
      expect(e.wilson95[0]).toBeLessThanOrEqual(e.wilson95[1]);
      for (const k of NV1_C1.ks) {
        expect(e.argmaxShare[k]).toBeGreaterThanOrEqual(0);
        expect(e.argmaxShare[k]).toBeLessThanOrEqual(1);
      }
    }

    const result2 = calibrate(coinsBC, replays, seedBase, stdDraws, nullDraws, edges);
    expect(result2).toEqual(result1);
  });
});

describe('assertLockPresent', () => {
  it('throws exact message when lock file is absent and succeeds when present', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'nv1-lock-guard-test-'));
    try {
      expect(() => assertLockPresent(tempDir)).toThrow(LOCK_GUARD_MESSAGE);
      expect(() => assertLockPresent(tempDir)).toThrow(
        'nv1: the C1 holdout test runs only after the Round 1 lock is committed'
      );

      writeFileSync(join(tempDir, 'next-version-v1.ts'), '// Round 1 lock file\n');
      expect(() => assertLockPresent(tempDir)).not.toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('wilsonScoreInterval and binomialSignTestP', () => {
  it('computes known Wilson interval and sign test p-values', () => {
    const [w0Low, w0High] = wilsonScoreInterval(0, 100);
    expect(w0Low).toBe(0);
    expect(w0High).toBeCloseTo(0.037, 2);

    const [w50Low, w50High] = wilsonScoreInterval(50, 100);
    expect(w50Low).toBeCloseTo(0.4038, 3);
    expect(w50High).toBeCloseTo(0.5962, 3);

    expect(binomialSignTestP(5, 5)).toBe(0.03125);
    expect(binomialSignTestP(4, 5)).toBe(0.1875);
    expect(binomialSignTestP(0, 5)).toBe(1);
  });
});
