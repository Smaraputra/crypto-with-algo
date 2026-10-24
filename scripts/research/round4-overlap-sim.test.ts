import { describe, expect, it } from 'vitest';
import { type LabBar, runEProcess } from '@/lib/signals/lab/e-process';
import {
  generateTrades,
  gradeDailyMtm,
  gradeOverlapping,
  makeRng,
  maxLogE,
  runStudy,
  wilson,
} from './round4-overlap-sim';

describe('round4-overlap-sim', () => {
  it('1. makeRng is deterministic for a seed, and two seeds differ', () => {
    const rng1a = makeRng(12345);
    const rng1b = makeRng(12345);
    const rng2 = makeRng(54321);

    const seq1a = Array.from({ length: 20 }, () => rng1a());
    const seq1b = Array.from({ length: 20 }, () => rng1b());
    const seq2 = Array.from({ length: 20 }, () => rng2());

    expect(seq1a).toEqual(seq1b);
    expect(seq1a).not.toEqual(seq2);
    for (const val of seq1a) {
      expect(val).toBeGreaterThan(0);
      expect(val).toBeLessThan(1);
    }
  });

  it('2. generateTrades on a hand-built return array respects blocking, sides, and return windows', () => {
    const sigma = 0.012;
    const lookback = 20;
    const holdHours = 8;
    const hours = 45;
    const logReturns: number[][] = [new Array(hours).fill(0)];

    // Hours 0 to 19 sum to 0.15 -> z = 0.15 / (0.012 * sqrt(20)) ≈ 2.795 > 2.2
    for (let h = 15; h < 20; h++) {
      logReturns[0][h] = 0.03;
    }
    // Hours 20 to 27 are the 8-hour hold window with known returns summing to 0.08
    for (let h = 20; h < 28; h++) {
      logReturns[0][h] = 0.01;
    }
    // Also keep hours 20 to 27 elevated so that if not blocked, T = 21..27 would trigger
    logReturns[0][20] = 0.04; // window 1..20 still has sum > 0.15
    // Hour 28: coin becomes free, and window 8..27 sum is large enough to re-enter
    for (let h = 21; h < 28; h++) {
      logReturns[0][h] = 0.02;
    }

    const contTrades = generateTrades(logReturns, {
      rule: 'cont',
      zStar: 2.2,
      sigma,
      lookback,
      holdHours,
    });

    expect(contTrades.length).toBeGreaterThanOrEqual(1);
    expect(contTrades[0].entryHour).toBe(20);
    expect(contTrades[0].side).toBe(1);

    // Sum of next 8 hourly log returns from T = 20: hours 20 to 27
    let expectedR = 0;
    for (let h = 20; h < 28; h++) {
      expectedR += logReturns[0][h];
    }
    expect(contTrades[0].r).toBeCloseTo(expectedR, 12);

    // Coin never re-enters before its 8 hours are up
    for (let i = 1; i < contTrades.length; i++) {
      const diff = contTrades[i].entryHour - contTrades[i - 1].entryHour;
      expect(diff).toBeGreaterThanOrEqual(holdHours);
    }

    // Side follows -sign(z) for fade
    const fadeTrades = generateTrades(logReturns, {
      rule: 'fade',
      zStar: 2.2,
      sigma,
      lookback,
      holdHours,
    });
    expect(fadeTrades[0].entryHour).toBe(20);
    expect(fadeTrades[0].side).toBe(-1);

    // Test negative z on coin 0
    const negReturns: number[][] = [new Array(hours).fill(0)];
    for (let h = 15; h < 20; h++) {
      negReturns[0][h] = -0.03;
    }
    const contNeg = generateTrades(negReturns, { rule: 'cont', zStar: 2.2, sigma });
    const fadeNeg = generateTrades(negReturns, { rule: 'fade', zStar: 2.2, sigma });
    expect(contNeg[0].side).toBe(-1);
    expect(fadeNeg[0].side).toBe(1);
  });

  it('3. gradeOverlapping matches hand computation, fee, clipping at 1, and omits empty hours', () => {
    const trades = [
      { coin: 0, entryHour: 10, side: 1, r: 0.05 },
      { coin: 1, entryHour: 10, side: -1, r: -0.02 },
      { coin: 2, entryHour: 30, side: 1, r: 0.2 },
    ];

    const bars = gradeOverlapping(trades, { fee: 0.0014, scale: 0.15 });

    // An hour with no entry gives no bar
    expect(bars).toHaveLength(2);

    // Hour 10: R = (1 * 0.05 + -1 * -0.02) - 0.0014 * 2 = 0.07 - 0.0028 = 0.0672
    // x = 0.0672 / 0.15 = 0.448
    expect(bars[0].barTime).toBe(10);
    expect(bars[0].R).toBeCloseTo(0.0672, 10);
    expect(bars[0].x).toBeCloseTo(0.448, 10);
    expect(bars[0].b).toBe(0);

    // Hour 30: R = 1 * 0.20 - 0.0014 = 0.1986
    // R / 0.15 = 1.324 -> clipped to 1
    expect(bars[1].barTime).toBe(30);
    expect(bars[1].R).toBeCloseTo(0.1986, 10);
    expect(bars[1].x).toBe(1);
    expect(bars[1].b).toBe(0);
  });

  it('4. gradeDailyMtm sums to trade returns minus costs (to 1e-12) and splits midnight trades', () => {
    const hours = 48;
    const logReturns: number[][] = [new Array(hours).fill(0)];

    // Day 0 (hours 20 to 23): sum = 0.01 + 0.015 + 0.02 + 0.025 = 0.07
    logReturns[0][20] = 0.01;
    logReturns[0][21] = 0.015;
    logReturns[0][22] = 0.02;
    logReturns[0][23] = 0.025;

    // Day 1 (hours 24 to 27): sum = 0.03 + 0.01 + 0.02 + 0.01 = 0.07
    logReturns[0][24] = 0.03;
    logReturns[0][25] = 0.01;
    logReturns[0][26] = 0.02;
    logReturns[0][27] = 0.01;

    const trade = { coin: 0, entryHour: 20, side: 1, r: 0.14 };
    const fee = 0.0014;
    const bars = gradeDailyMtm([trade], logReturns, { fee, scale: 0.15 });

    // Trade spans midnight: Day 0 (hours 20..23) and Day 1 (hours 24..27)
    expect(bars).toHaveLength(2);
    expect(bars[0].barTime).toBe(0);
    expect(bars[1].barTime).toBe(1);

    // Day 0 includes fee
    const expectedDay0 = 1 * 0.07 - fee;
    // Day 1 has no entry fee
    const expectedDay1 = 1 * 0.07;

    expect(bars[0].R).toBeCloseTo(expectedDay0, 12);
    expect(bars[1].R).toBeCloseTo(expectedDay1, 12);

    const totalMtm = bars.reduce((acc, b) => acc + b.R, 0);
    const expectedTotal = trade.side * trade.r - fee;
    expect(Math.abs(totalMtm - expectedTotal)).toBeLessThan(1e-12);
  });

  it('5. maxLogE equals maximum of runEProcess steps state.logE for a fixed bar list', () => {
    const bars: LabBar[] = [
      { barTime: 1, x: 0.2, b: 0 },
      { barTime: 2, x: -0.1, b: 0 },
      { barTime: 3, x: 0.5, b: 0 },
      { barTime: 4, x: -0.8, b: 0 },
      { barTime: 5, x: 0.3, b: 0 },
    ];

    const steps = runEProcess(bars, undefined, { lossUnbounded: true });
    const expectedMax = Math.max(...steps.map((s) => s.state.logE));
    const actualMax = maxLogE(bars, { lossUnbounded: true });

    expect(actualMax).toBe(expectedMax);
  });

  it('6. wilson(0, 10) lower is 0, and wilson(5, 10) is about [0.237, 0.763]', () => {
    const w0 = wilson(0, 10);
    expect(w0.lower).toBe(0);
    expect(w0[0]).toBe(0);

    const w5 = wilson(5, 10);
    expect(w5.lower).toBeCloseTo(0.237, 3);
    expect(w5.upper).toBeCloseTo(0.763, 3);
    expect(w5[0]).toBeCloseTo(0.237, 3);
    expect(w5[1]).toBeCloseTo(0.763, 3);
  });

  it('7. runStudy with paths: 20, seed: 1 and one cell returns report shape and is reproducible', () => {
    const options = {
      paths: 20,
      seed: 1,
      cells: [{ rule: 'cont' as const, rho: 0.7, tails: 'normal' as const }],
    };

    const rep1 = runStudy(options);
    const rep2 = runStudy(options);

    expect(rep1).toEqual(rep2);
    expect(rep1.paths).toBe(20);
    expect(rep1.seed).toBe(1);
    expect(rep1.cells).toHaveLength(1);

    const cell = rep1.cells[0];
    expect(cell.rule).toBe('cont');
    expect(cell.rho).toBe(0.7);
    expect(cell.tails).toBe('normal');
    expect(cell.meanTradesPerDay).toBeGreaterThan(0);
    expect(cell.shareMultiCoinHours).toBeGreaterThanOrEqual(0);
    expect(cell.shareMultiCoinHours).toBeLessThanOrEqual(1);

    for (const gKey of ['A', 'B', 'C'] as const) {
      const g = cell.gradings[gKey];
      expect(g.thresholds).toHaveLength(7);
      for (const t of g.thresholds) {
        expect(t.share).toBeGreaterThanOrEqual(0);
        expect(t.share).toBeLessThanOrEqual(1);
        expect(t.wilson[0]).toBeGreaterThanOrEqual(0);
        expect(t.wilson[1]).toBeLessThanOrEqual(1);
        expect(t.bound).toBe(1 / t.k);
        expect(t.exceedsBound).toBe(t.wilson[0] > t.bound);
      }
    }
  });
});
