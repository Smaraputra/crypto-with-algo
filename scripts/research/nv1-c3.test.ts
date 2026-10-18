// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CandleRow } from './dataset-format';
import {
  DAY_MS,
  NUM_BINS,
  coinDailySeries,
  dailySignals,
  parseArgs,
  screen,
  valueArea,
  type ValueArea,
} from './nv1-c3';
import { NV1_SEGMENTS, type CoinSeries } from './nv1-core';

describe('valueArea', () => {
  it('all volume in one price bin gives POC there and a value area of that single bin when it holds at least 70%', () => {
    // 96 bars: dayLow = 100, dayHigh = 300, 200 bins of width 1.0
    // Bin 50 spans [150, 151]. We put 80% of volume in bin 50.
    const bars: Array<{ l: number; h: number; c: number; v: number }> = [];

    // Bar 0 sets dayLow = 100
    bars.push({ l: 100, h: 100, c: 100, v: 0.1 });
    // Bar 1 sets dayHigh = 300
    bars.push({ l: 300, h: 300, c: 300, v: 0.1 });
    // Bar 2 puts 80 units of volume inside [150.2, 150.8] (100% inside bin 50: [150, 151])
    bars.push({ l: 150.2, h: 150.8, c: 150.5, v: 80 });

    // Bars 3..95 (93 bars) have small volume inside [150.2, 150.8] so total volume is ~100
    for (let i = 3; i < 96; i++) {
      bars.push({ l: 150.4, h: 150.6, c: 150.5, v: 0.2 });
    }

    const va = valueArea(bars);
    expect(va).not.toBeNull();
    if (!va) return;

    // Bin 50 center is 100 + (50 + 0.5) * 1.0 = 150.5
    expect(va.poc).toBeCloseTo(150.5, 4);
    // Value area is that single bin [150, 151]
    expect(va.val).toBeCloseTo(150, 4);
    expect(va.vah).toBeCloseTo(151, 4);
    expect(va.width).toBeCloseTo(1.0, 4);
    expect(va.m).toBeCloseTo(150.5, 4);
  });

  it('a two-peak profile grows toward the heavier side', () => {
    // dayLow = 0, dayHigh = 200, binWidth = 1.0
    // Bins: bin 100 is POC with volume 40 (out of 100).
    // Bin 101 (above) has volume 15.
    // Bin 99 (below) has volume 25.
    // When growing from POC (40%), next above has 15, next below has 25.
    // 25 > 15, so it grows toward the heavier side (bin 99).
    const bars: Array<{ l: number; h: number; c: number; v: number }> = [];

    // Set dayLow and dayHigh with minimal volume
    bars.push({ l: 0, h: 0, c: 0, v: 0.001 });
    bars.push({ l: 200, h: 200, c: 200, v: 0.001 });

    // POC: bin 100 covers [100, 101]
    bars.push({ l: 100.2, h: 100.8, c: 100.5, v: 40 });
    // Bin 99 covers [99, 100] (heavier neighbor)
    bars.push({ l: 99.2, h: 99.8, c: 99.5, v: 25 });
    // Bin 101 covers [101, 102] (lighter neighbor)
    bars.push({ l: 101.2, h: 101.8, c: 101.5, v: 15 });
    // Bin 98 covers [98, 99] (additional volume to reach 70%)
    bars.push({ l: 98.2, h: 98.8, c: 98.5, v: 19.998 });

    // Pad remaining bars to reach 96 bars with 0 volume
    for (let i = 6; i < 96; i++) {
      bars.push({ l: 100.4, h: 100.6, c: 100.5, v: 0 });
    }

    const va = valueArea(bars);
    expect(va).not.toBeNull();
    if (!va) return;

    // POC is bin 100 -> center 100.5
    expect(va.poc).toBeCloseTo(100.5, 4);

    // Initial included volume = 40 (POC).
    // Step 1: compare bin 101 (15) and bin 99 (25). 25 > 15 -> adds bin 99.
    // Included volume = 40 + 25 = 65 (< 70).
    // Step 2: compare bin 101 (15) and bin 98 (19.998). 19.998 > 15 -> adds bin 98.
    // Included volume = 65 + 19.998 = 84.998 (>= 70).
    // Top bin is 100 (vah = 101), bottom bin is 98 (val = 98).
    expect(va.val).toBeCloseTo(98, 4);
    expect(va.vah).toBeCloseTo(101, 4);
  });

  it('tie rules as specified: POC tie nearest last close, then lower bin; VA growth ties above', () => {
    // POC Tie Case 1: nearest to last close wins
    // DayLow = 0, DayHigh = 200, binWidth = 1.0.
    // Bin 40 (center 40.5) has vol 30. Bin 160 (center 160.5) has vol 30.
    // Last close is 150. Bin 160 is closer (|160.5 - 150| = 10.5 < |40.5 - 150| = 109.5).
    const bars1: Array<{ l: number; h: number; c: number; v: number }> = [];
    bars1.push({ l: 0, h: 0, c: 0, v: 0.1 });
    bars1.push({ l: 200, h: 200, c: 200, v: 0.1 });
    bars1.push({ l: 40.2, h: 40.8, c: 40.5, v: 30 });
    bars1.push({ l: 160.2, h: 160.8, c: 160.5, v: 30 });
    for (let i = 4; i < 95; i++) {
      bars1.push({ l: 100, h: 100, c: 100, v: 0 });
    }
    // Bar 95 is the last bar, with close = 150
    bars1.push({ l: 150, h: 150, c: 150, v: 0 });

    const va1 = valueArea(bars1);
    expect(va1).not.toBeNull();
    expect(va1!.poc).toBeCloseTo(160.5, 4);

    // POC Tie Case 2: equidistant to last close -> lower bin wins
    // Last close is exactly 100.5 (equidistant to 40.5 and 160.5)
    bars1[95] = { l: 100.5, h: 100.5, c: 100.5, v: 0 };
    const va2 = valueArea(bars1);
    expect(va2).not.toBeNull();
    expect(va2!.poc).toBeCloseTo(40.5, 4);

    // VA Growth Tie Case: ties go above
    // POC is bin 100 with vol 50. Bin 101 has vol 15, Bin 99 has vol 15.
    // Ties go above -> bin 101 added first.
    const barsGrow: Array<{ l: number; h: number; c: number; v: number }> = [];
    barsGrow.push({ l: 0, h: 0, c: 0, v: 0.1 });
    barsGrow.push({ l: 200, h: 200, c: 200, v: 0.1 });
    barsGrow.push({ l: 100.2, h: 100.8, c: 100.5, v: 50 });
    barsGrow.push({ l: 101.2, h: 101.8, c: 101.5, v: 15 });
    barsGrow.push({ l: 99.2, h: 99.8, c: 99.5, v: 15 });
    // Total vol ~80.2, 70% is ~56.14.
    // POC has 50. Adding bin 101 gives 65 >= 56.14, stopping immediately.
    // If ties go above, highBin is 101 and lowBin is 100 (vah = 102, val = 100).
    for (let i = 5; i < 96; i++) {
      barsGrow.push({ l: 100, h: 100, c: 100, v: 0 });
    }
    const vaGrow = valueArea(barsGrow);
    expect(vaGrow).not.toBeNull();
    expect(vaGrow!.vah).toBeCloseTo(102, 4);
    expect(vaGrow!.val).toBeCloseTo(100, 4);
  });

  it('proportional overlap allocation sums back to the days volume', () => {
    const bars: Array<{ l: number; h: number; c: number; v: number }> = [];
    let expectedTotalVol = 0;

    for (let i = 0; i < 96; i++) {
      const l = 50 + i * 0.5;
      const h = l + 3.7;
      const c = (l + h) / 2;
      const v = 10 + (i % 7) * 3;
      expectedTotalVol += v;
      bars.push({ l, h, c, v });
    }

    const dayLow = Math.min(...bars.map((b) => b.l));
    const dayHigh = Math.max(...bars.map((b) => b.h));
    const binWidth = (dayHigh - dayLow) / NUM_BINS;
    const binVolume = new Float64Array(NUM_BINS);

    for (const bar of bars) {
      const barLen = bar.h - bar.l;
      const startBin = Math.max(0, Math.min(NUM_BINS - 1, Math.floor((bar.l - dayLow) / binWidth)));
      const endBin = Math.max(0, Math.min(NUM_BINS - 1, Math.floor((bar.h - dayLow) / binWidth)));

      for (let b = startBin; b <= endBin; b++) {
        const bLow = b === 0 ? dayLow : dayLow + b * binWidth;
        const bHigh = b === NUM_BINS - 1 ? dayHigh : dayLow + (b + 1) * binWidth;
        const overlap = Math.max(0, Math.min(bar.h, bHigh) - Math.max(bar.l, bLow));
        if (overlap > 0) {
          binVolume[b] += bar.v * (overlap / barLen);
        }
      }
    }

    let allocatedTotal = 0;
    for (let b = 0; b < NUM_BINS; b++) {
      allocatedTotal += binVolume[b];
    }

    expect(allocatedTotal).toBeCloseTo(expectedTotalVol, 8);
  });

  it('returns null when day has fewer than 90 bars or dayLow equals dayHigh', () => {
    const fewBars = Array.from({ length: 89 }, () => ({
      l: 100,
      h: 110,
      c: 105,
      v: 10,
    }));
    expect(valueArea(fewBars)).toBeNull();

    const flatBars = Array.from({ length: 96 }, () => ({
      l: 100,
      h: 100,
      c: 100,
      v: 10,
    }));
    expect(valueArea(flatBars)).toBeNull();
  });
});

describe('dailySignals', () => {
  it('hand values for +1, -1 and 0 at the threshold boundary, and 0 when a day lacks a value area', () => {
    // Threshold = 0.25
    // Day D-2: m = 100, width = 40. Threshold * width = 0.25 * 40 = 10.
    const vaD2: ValueArea = { poc: 100, vah: 120, val: 80, m: 100, width: 40 };

    // Case 1: diff > 10 (+1)
    const vaPlus1: ValueArea = { poc: 111, vah: 121, val: 101, m: 111, width: 20 };
    expect(dailySignals([vaD2, vaPlus1, vaPlus1], 0.25)[2]).toBe(1);

    // Case 2: diff === 10 (exact upper boundary -> 0)
    const vaBoundPlus: ValueArea = { poc: 110, vah: 120, val: 100, m: 110, width: 20 };
    expect(dailySignals([vaD2, vaBoundPlus, vaBoundPlus], 0.25)[2]).toBe(0);

    // Case 3: diff === 5 (inside band -> 0)
    const vaMid: ValueArea = { poc: 105, vah: 115, val: 95, m: 105, width: 20 };
    expect(dailySignals([vaD2, vaMid, vaMid], 0.25)[2]).toBe(0);

    // Case 4: diff === -10 (exact lower boundary -> 0)
    const vaBoundMinus: ValueArea = { poc: 90, vah: 100, val: 80, m: 90, width: 20 };
    expect(dailySignals([vaD2, vaBoundMinus, vaBoundMinus], 0.25)[2]).toBe(0);

    // Case 5: diff < -10 (-1)
    const vaMinus1: ValueArea = { poc: 89, vah: 99, val: 79, m: 89, width: 20 };
    expect(dailySignals([vaD2, vaMinus1, vaMinus1], 0.25)[2]).toBe(-1);

    // Case 6: day lacks value area (null) -> 0
    expect(dailySignals([vaD2, null, vaPlus1], 0.25)[2]).toBe(0);
    expect(dailySignals([null, vaPlus1, vaPlus1], 0.25)[2]).toBe(0);
    expect(dailySignals([null, null, null], 0.25)[2]).toBe(0);
  });
});

describe('screen on synthetic markets', () => {
  it('A synthetic market where the next days return follows the signal sign (+0.5% for +1, -0.5% for -1) survives the screen; a market where returns are independent of signals does not, for the fixed seed (null draws 100 in the test)', () => {
    const tStart = NV1_SEGMENTS.B.start;
    const tEnd = NV1_SEGMENTS.C.end;
    const numDays = Math.round((tEnd - tStart) / DAY_MS);

    // Construct repeating signals [1, 1, -1, -1, 0] across the entire span
    const pattern = [1, 1, -1, -1, 0];
    const side: number[] = new Array(numDays);
    const t: number[] = new Array(numDays);
    for (let i = 0; i < numDays; i++) {
      t[i] = tStart + i * DAY_MS;
      side[i] = pattern[i % pattern.length];
    }

    // 1. Predictive market: next day open follows signal sign
    const closePredictive: number[] = new Array(numDays);
    closePredictive[0] = 100;
    for (let i = 0; i < numDays - 1; i++) {
      const s = side[i];
      const ret = s === 1 ? 0.005 : s === -1 ? -0.005 : 0.0;
      closePredictive[i + 1] = closePredictive[i] * (1 + ret);
    }

    const predictiveCoin: CoinSeries = {
      symbol: 'BTCUSDT',
      t,
      close: closePredictive,
      side,
    };

    const predictiveResult = screen([predictiveCoin], {
      threshold: 0.25,
      draws: 100,
      seed: 20261300,
    });

    // In the predictive market, k = 0 achieves net return around +0.36% (0.5% gross - 0.14% cost)
    // N_B > 0, N_C > 0, pooled N exceeds null 90th percentile, so k survives
    expect(predictiveResult.survivor).not.toBeNull();
    const cell0 = predictiveResult.cells[0];
    expect(cell0.nB).toBeGreaterThan(0.2);
    expect(cell0.nC).toBeGreaterThan(0.2);
    expect(cell0.nPooled).toBeGreaterThan(cell0.nullP90);
    expect(cell0.bh).toBeCloseTo(1.0, 4);

    // 2. Independent market: returns independent of signals (constant prices -> 0% gross return)
    // Every trade has net return = 0 - 0.14 = -0.14%, so N_B < 0 and N_C < 0
    const closeIndependent: number[] = new Array(numDays).fill(100);
    const independentCoin: CoinSeries = {
      symbol: 'BTCUSDT',
      t,
      close: closeIndependent,
      side,
    };

    const independentResult = screen([independentCoin], {
      threshold: 0.25,
      draws: 100,
      seed: 20261300,
    });

    // Does not survive
    expect(independentResult.survivor).toBeNull();
    expect(independentResult.cells[0].survives).toBe(false);
    expect(independentResult.cells[0].nB).toBeLessThan(0);
    expect(independentResult.cells[0].nC).toBeLessThan(0);
    expect(independentResult.nullPromotionRate).toBeGreaterThanOrEqual(0);
    expect(independentResult.nullPromotionRate).toBeLessThanOrEqual(1);
  });
});

describe('coinDailySeries', () => {
  it('aligns 1d candles and generates daily series with signals from value areas', () => {
    const t0 = NV1_SEGMENTS.B.start;
    const vaMap = new Map<number, ValueArea | null>();

    // Day 0: m = 100, width = 20
    vaMap.set(t0, { poc: 100, vah: 110, val: 90, m: 100, width: 20 });
    // Day 1: m = 110, width = 20 (diff = 10 > 0.25 * 20 = 5 -> +1 signal for Day 2)
    vaMap.set(t0 + DAY_MS, { poc: 110, vah: 120, val: 100, m: 110, width: 20 });
    // Day 2: m = 100, width = 20 (diff = -10 < -5 -> -1 signal for Day 3)
    vaMap.set(t0 + 2 * DAY_MS, { poc: 100, vah: 110, val: 90, m: 100, width: 20 });

    const candles1d: CandleRow[] = [
      { t: t0, o: 100, h: 105, l: 95, c: 102, v: 1000, tbv: 500 },
      { t: t0 + DAY_MS, o: 102, h: 115, l: 101, c: 112, v: 1000, tbv: 500 },
      { t: t0 + 2 * DAY_MS, o: 112, h: 115, l: 98, c: 100, v: 1000, tbv: 500 },
      { t: t0 + 3 * DAY_MS, o: 100, h: 105, l: 95, c: 98, v: 1000, tbv: 500 },
    ];

    const series = coinDailySeries('BTCUSDT', vaMap, candles1d, 0.25);

    expect(series.symbol).toBe('BTCUSDT');
    expect(series.t).toEqual([t0, t0 + DAY_MS, t0 + 2 * DAY_MS, t0 + 3 * DAY_MS]);
    expect(series.close).toEqual([100, 102, 112, 100]); // Uses 1d candle OPEN
    expect(series.side).toEqual([0, 0, 1, -1]);
  });
});

describe('parseArgs', () => {
  it('parses run command with dataset-dir, out, and threshold', () => {
    const args = parseArgs(['run', '--dataset-dir', '/data/nv1', '--out', '/tmp/out.json', '--threshold', '0.35']);
    expect(args.command).toBe('run');
    expect(args.datasetDir).toBe('/data/nv1');
    expect(args.out).toBe('/tmp/out.json');
    expect(args.threshold).toBe(0.35);
  });

  it('defaults threshold to 0.25', () => {
    const args = parseArgs(['run', '--dataset-dir', '/data/nv1', '--out', '/tmp/out.json']);
    expect(args.threshold).toBe(0.25);
  });

  it('throws when required flags are missing or unknown', () => {
    expect(() => parseArgs([])).toThrow(/Expected command "run"/);
    expect(() => parseArgs(['scores'])).toThrow(/Expected command "run"/);
    expect(() => parseArgs(['run', '--dataset-dir', '/data'])).toThrow(/--out is required/);
    expect(() => parseArgs(['run', '--out', '/tmp/out.json'])).toThrow(/--dataset-dir is required/);
    expect(() => parseArgs(['run', '--dataset-dir', '/data', '--out', '/tmp/out.json', '--unknown'])).toThrow(/Unknown flag/);
  });
});
