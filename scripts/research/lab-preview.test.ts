// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  hurdleSeries,
  l1RanksAt,
  l1ScoreBars,
  l2ScoreBars,
  l3ScoreBars,
  nullCalibration,
  returnBarsFromPanel,
  returnBarsFromRows,
  type ReturnBar,
  type ScoreBar,
  summarise,
} from './lab-preview';
import type { HourBar } from '@/lib/signals/lab/factors';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import type { RvPanel } from './rv-panel';

const SYMBOLS_10 = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'] as const;

describe('lab-preview', () => {
  describe('summarise', () => {
    it('summarises numbers with quantiles interpolated linearly', () => {
      const s = summarise([1, 2, 3, 4, null, Number.NaN]);
      expect(s.n).toBe(4);
      expect(s.mean).toBeCloseTo(2.5, 6);
      expect(s.p10).toBeCloseTo(1.3, 6);
      expect(s.p50).toBeCloseTo(2.5, 6);
      expect(s.p90).toBeCloseTo(3.7, 6);
    });

    it('returns n 0 and nulls for an empty array', () => {
      const s = summarise([]);
      expect(s.n).toBe(0);
      expect(s.mean).toBeNull();
      expect(s.p10).toBeNull();
      expect(s.p50).toBeNull();
      expect(s.p90).toBeNull();
    });
  });

  describe('hurdleSeries', () => {
    it('calculates turnover, sHat and hurdle b across consecutive bars', () => {
      const scoreBars: ScoreBar[] = [
        {
          t: 1,
          scores: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, (i + 1) * 10])),
        },
        {
          t: 2,
          scores: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, (10 - i) * 5])),
        },
        {
          t: 3,
          scores: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, ((i * 3) % 10) * 8])),
        },
      ];

      const returnBars: ReturnBar[] = [1, 2, 3].map((t) => ({
        t,
        returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.01 * (i - 4.5)])),
      }));

      const points = hurdleSeries(scoreBars, returnBars);
      expect(points.length).toBe(3);

      // Point 1: entering from flat
      expect(points[0].turnover).toBeCloseTo(1, 6);
      expect(points[0].sHat).toBeNull();
      expect(points[0].b).toBeNull();
      expect(points[0].s).not.toBeNull();

      // Point 2: sHat is point 1's s
      const s1 = points[0].s!;
      expect(points[1].sHat).toBeCloseTo(s1, 6);
      const expectedB2 = (points[1].turnover! * 0.0007) / (points[1].kN! * s1);
      expect(points[1].b).toBeCloseTo(expectedB2, 6);

      // Point 3: sHat is mean of s1 and s2
      const s2 = points[1].s!;
      const expectedSHat3 = (s1 + s2) / 2;
      expect(points[2].sHat).toBeCloseTo(expectedSHat3, 6);
    });

    it('gives turnover 0 from point 2 on when scores do not change', () => {
      const fixedScores = Object.fromEntries(SYMBOLS_10.map((s, i) => [s, (i + 1) * 10]));
      const scoreBars: ScoreBar[] = [
        { t: 1, scores: { ...fixedScores } },
        { t: 2, scores: { ...fixedScores } },
        { t: 3, scores: { ...fixedScores } },
      ];
      const returnBars: ReturnBar[] = [1, 2, 3].map((t) => ({
        t,
        returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.01 * (i - 4.5)])),
      }));

      const points = hurdleSeries(scoreBars, returnBars);
      expect(points[0].turnover).toBeCloseTo(1, 6);
      expect(points[1].turnover).toBeCloseTo(0, 6);
      expect(points[2].turnover).toBeCloseTo(0, 6);
    });

    it('skips bars with n < 8 as prevWeights and excludes their s from future sHat', () => {
      const scoreBars: ScoreBar[] = [
        {
          t: 1,
          scores: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, (i + 1) * 10])),
        },
        {
          t: 2,
          scores: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, (10 - i) * 5])),
        },
        {
          t: 3,
          scores: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, (i + 1) * 10])),
        },
      ];

      // Bar 2 returns only 7 coins (S0..S6)
      const returnBars: ReturnBar[] = [
        {
          t: 1,
          returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.01 * (i - 4.5)])),
        },
        {
          t: 2,
          returns: Object.fromEntries(SYMBOLS_10.slice(0, 7).map((s, i) => [s, 0.01 * (i - 3)])),
        },
        {
          t: 3,
          returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.01 * (i - 4.5)])),
        },
      ];

      const points = hurdleSeries(scoreBars, returnBars);

      // Point 2 has n 7 and all metric fields null
      expect(points[1].n).toBe(7);
      expect(points[1].turnover).toBeNull();
      expect(points[1].kN).toBeNull();
      expect(points[1].s).toBeNull();
      expect(points[1].sHat).toBeNull();
      expect(points[1].b).toBeNull();

      // Point 3 compares turnover against point 1, because point 2 was skipped as prevWeights
      // Since scoreBar 1 and scoreBar 3 have identical scores, turnover against point 1 is 0
      expect(points[2].turnover).toBeCloseTo(0, 6);

      // Point 3's sHat uses only point 1's s, because point 2's s is null
      expect(points[2].sHat).toBeCloseTo(points[0].s!, 6);
    });

    it('preserves predictability: changing bar 3 returns leaves prior bars and point 3 hurdle unchanged', () => {
      const scoreBars: ScoreBar[] = [
        {
          t: 1,
          scores: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, (i + 1) * 10])),
        },
        {
          t: 2,
          scores: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, (10 - i) * 5])),
        },
        {
          t: 3,
          scores: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, ((i * 3) % 10) * 8])),
        },
      ];

      const returnBarsA: ReturnBar[] = [
        { t: 1, returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.01 * (i - 4.5)])) },
        { t: 2, returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.02 * (4.5 - i)])) },
        { t: 3, returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.015 * (i - 4.5)])) },
      ];

      const returnBarsB: ReturnBar[] = [
        { t: 1, returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.01 * (i - 4.5)])) },
        { t: 2, returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.02 * (4.5 - i)])) },
        { t: 3, returns: Object.fromEntries(SYMBOLS_10.map((s, i) => [s, 0.05 * (4.5 - i)])) },
      ];

      const pointsA = hurdleSeries(scoreBars, returnBarsA);
      const pointsB = hurdleSeries(scoreBars, returnBarsB);

      // Bars 1 and 2 are identical
      expect(pointsA[0]).toEqual(pointsB[0]);
      expect(pointsA[1]).toEqual(pointsB[1]);

      // At bar 3: sHat and b are identical, only s differs
      expect(pointsA[2].sHat).toBeCloseTo(pointsB[2].sHat!, 6);
      expect(pointsA[2].b).toBeCloseTo(pointsB[2].b!, 6);
      expect(pointsA[2].s).not.toBeCloseTo(pointsB[2].s!, 4);
    });
  });

  describe('nullCalibration', () => {
    it('calibrates e-process null on synthetic returns deterministically', () => {
      const rand = createSeededRandom(42);
      const sampleNormal = (): number => {
        let u1 = rand();
        while (u1 <= 0 || u1 >= 1) {
          u1 = rand();
        }
        const u2 = rand();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      };

      const returnBars: ReturnBar[] = [];
      const hurdleByT = new Map<number, number | null>();

      for (let t = 1; t <= 300; t++) {
        const returns: Record<string, number> = {};
        for (const sym of SYMBOLS_10) {
          returns[sym] = 0.01 * sampleNormal();
        }
        returnBars.push({ t, returns });
        hurdleByT.set(t, 0.01);
      }

      const res1 = nullCalibration(returnBars, hurdleByT, { runs: 50, seed: 20261018 });
      expect(res1.bars).toBe(300);
      expect(res1.runs).toBe(50);
      expect(res1.crossings).toBe(0);
      expect(res1.crossingsB0).toBeLessThanOrEqual(1);

      const res2 = nullCalibration(returnBars, hurdleByT, { runs: 50, seed: 20261018 });
      expect(res2).toEqual(res1);
    });
  });

  describe('l1RanksAt', () => {
    it('picks the latest bar at or before t and ranks descending with tied symbol fallback', () => {
      const l1Bars: ScoreBar[] = [
        {
          t: 100,
          scores: { S0: 1.5, S1: 2.5, S2: -0.5 },
        },
        {
          t: 200,
          scores: { S0: 0.1, S1: 3.0, S2: 1.0 },
        },
      ];

      // Before first bar
      expect(l1RanksAt(l1Bars, 50)).toBeNull();

      // Between bar 1 and bar 2
      const ranks150 = l1RanksAt(l1Bars, 150);
      expect(ranks150).toEqual([
        { symbol: 'S1', compositeZ: 2.5, rank: 1 },
        { symbol: 'S0', compositeZ: 1.5, rank: 2 },
        { symbol: 'S2', compositeZ: -0.5, rank: 3 },
      ]);

      // At bar 2
      const ranks200 = l1RanksAt(l1Bars, 200);
      expect(ranks200).toEqual([
        { symbol: 'S1', compositeZ: 3.0, rank: 1 },
        { symbol: 'S2', compositeZ: 1.0, rank: 2 },
        { symbol: 'S0', compositeZ: 0.1, rank: 3 },
      ]);
    });
  });

  describe('l2ScoreBars', () => {
    it('combines v8 scores and L1 ranks, skipping when no valid L1 bar is available', () => {
      const rows = [
        { symbol: 'S0', candleTimestamp: 0, score: 40 },
        { symbol: 'S1', candleTimestamp: 0, score: 60 },
      ];
      const intervalMs = 3_600_000;
      const symbols = ['S0', 'S1'];

      // L1 bar available at t = 3_600_000
      const l1Bars: ScoreBar[] = [
        { t: 3_600_000, scores: { S0: 2.0, S1: 1.0 } },
      ];

      const scoreBars = l2ScoreBars(rows, intervalMs, symbols, l1Bars);
      expect(scoreBars.length).toBe(1);
      expect(scoreBars[0].t).toBe(3_600_000);

      // In L1: S0 compositeZ 2.0 (rank 1), S1 compositeZ 1.0 (rank 2)
      // S0 score = 0.5 * 40 + 0.5 * 100 * (5.5 - 1) / 4.5 = 20 + 50 = 70
      const expectedS0 = 0.5 * 40 + 0.5 * ((100 * (5.5 - 1)) / 4.5);
      const expectedS1 = 0.5 * 60 + 0.5 * ((100 * (5.5 - 2)) / 4.5);

      expect(scoreBars[0].scores.S0).toBeCloseTo(expectedS0, 6);
      expect(scoreBars[0].scores.S1).toBeCloseTo(expectedS1, 6);

      // An L1 bar later than t gives no ScoreBar
      const lateL1Bars: ScoreBar[] = [
        { t: 7_200_000, scores: { S0: 2.0, S1: 1.0 } },
      ];
      const emptyBars = l2ScoreBars(rows, intervalMs, symbols, lateL1Bars);
      expect(emptyBars.length).toBe(0);
    });
  });

  describe('l3ScoreBars', () => {
    it('computes negative realized variance over the 169-bar window ending at each close', () => {
      const symbols = ['S0', 'S1'];
      const barsBySymbol: Record<string, HourBar[]> = { S0: [], S1: [] };

      // Generate 200 contiguous 1h bars
      for (let i = 0; i < 200; i++) {
        const openTime = i * 3_600_000;
        const closeTime = openTime + 3_600_000 - 1;
        const closeS0 = 100 * Math.exp(0.001 * i);
        const closeS1 = 200 * Math.exp(-0.0015 * i);

        barsBySymbol.S0.push({ openTime, closeTime, close: closeS0 });
        barsBySymbol.S1.push({ openTime, closeTime, close: closeS1 });
      }

      const T1 = 175 * 3_600_000;
      const T2 = 190 * 3_600_000;
      const earlyT = 50 * 3_600_000;

      const scoreBars = l3ScoreBars(barsBySymbol, [T1, T2, earlyT], symbols);
      expect(scoreBars.length).toBe(3);

      // earlyT: close too early for 169 bars yields a ScoreBar without scored symbols
      const earlyBar = scoreBars.find((b) => b.t === earlyT);
      expect(earlyBar).toBeDefined();
      expect(earlyBar!.scores.S0).toBeUndefined();
      expect(earlyBar!.scores.S1).toBeUndefined();

      // Check T1 score against manually computed variance of 168 returns
      const barT1 = scoreBars.find((b) => b.t === T1);
      expect(barT1).toBeDefined();

      const startIndexT1 = 175 - 169;
      const windowT1 = barsBySymbol.S0.slice(startIndexT1, 175);
      let varianceS0 = 0;
      for (let k = 1; k < windowT1.length; k++) {
        const r = Math.log(windowT1[k].close / windowT1[k - 1].close);
        varianceS0 += r * r;
      }

      expect(barT1!.scores.S0).toBeCloseTo(-varianceS0, 10);
    });
  });

  describe('returnBarsFromRows and returnBarsFromPanel', () => {
    it('computes returns c / o - 1 and skips rows with open <= 0', () => {
      const rowsBySymbol = {
        S0: [
          { t: 100, o: 50, c: 55 },
          { t: 200, o: 0, c: 10 },
          { t: 300, o: 100, c: 90 },
        ],
        S1: [
          { t: 100, o: 20, c: 22 },
          { t: 200, o: 40, c: 44 },
          { t: 300, o: -5, c: 10 },
        ],
      };

      const bars = returnBarsFromRows(rowsBySymbol);
      expect(bars.length).toBe(3);

      // t = 100: both valid
      expect(bars[0].t).toBe(100);
      expect(bars[0].returns.S0).toBeCloseTo(0.1, 6);
      expect(bars[0].returns.S1).toBeCloseTo(0.1, 6);

      // t = 200: S0 has o = 0, so S0 skipped
      expect(bars[1].t).toBe(200);
      expect(bars[1].returns.S0).toBeUndefined();
      expect(bars[1].returns.S1).toBeCloseTo(0.1, 6);

      // t = 300: S1 has o = -5, so S1 skipped
      expect(bars[2].t).toBe(300);
      expect(bars[2].returns.S0).toBeCloseTo(-0.1, 6);
      expect(bars[2].returns.S1).toBeUndefined();
    });

    it('computes returnBarsFromPanel correctly', () => {
      const panel: RvPanel = {
        symbols: ['S0', 'S1'],
        t: [1000, 2000],
        open: [
          [100, 0],
          [50, 60],
        ],
        high: [
          [105, 10],
          [55, 65],
        ],
        low: [
          [95, 0],
          [45, 55],
        ],
        close: [
          [110, 10],
          [55, 54],
        ],
        volume: [
          [1000, 1000],
          [1000, 1000],
        ],
        tbv: [
          [500, 500],
          [500, 500],
        ],
        fundSum: [
          [0, 0],
          [0, 0],
        ],
        fundLast: [
          [0, 0],
          [0, 0],
        ],
      };

      const bars = returnBarsFromPanel(panel);
      expect(bars.length).toBe(2);

      // Bar 0
      expect(bars[0].returns.S0).toBeCloseTo(0.1, 6);
      expect(bars[0].returns.S1).toBeCloseTo(0.1, 6);

      // Bar 1: S0 open is 0, so skipped
      expect(bars[1].returns.S0).toBeUndefined();
      expect(bars[1].returns.S1).toBeCloseTo(-0.1, 6);
    });
  });

  describe('l1ScoreBars fixture', () => {
    it('produces score bars from a minimal 44-bar 10-symbol RvPanel', () => {
      const H8 = 8 * 3_600_000;
      const symbols = [
        'BTCUSDT',
        'ETHUSDT',
        'BNBUSDT',
        'SOLUSDT',
        'XRPUSDT',
        'ADAUSDT',
        'DOGEUSDT',
        'AVAXUSDT',
        'DOTUSDT',
        'LINKUSDT',
      ];
      const n = 44;

      const panel: RvPanel = {
        symbols,
        t: Array.from({ length: n }, (_, i) => 1_000_000_000 + i * H8),
        open: [],
        high: [],
        low: [],
        close: [],
        volume: [],
        tbv: [],
        fundSum: [],
        fundLast: [],
      };

      for (let s = 0; s < symbols.length; s++) {
        const oArr: number[] = [];
        const hArr: number[] = [];
        const lArr: number[] = [];
        const cArr: number[] = [];
        const vArr: number[] = [];
        const tbvArr: number[] = [];
        const fsArr: number[] = [];
        const flArr: number[] = [];

        for (let i = 0; i < n; i++) {
          oArr.push(100 + s * 10);
          hArr.push(105 + s * 10);
          lArr.push(95 + s * 10);
          cArr.push(102 + s * 10 + (i % 2 === 0 ? 1 : -1));
          vArr.push(1000);
          tbvArr.push(500);
          fsArr.push(0.0001);
          flArr.push(0.0001);
        }

        panel.open.push(oArr);
        panel.high.push(hArr);
        panel.low.push(lArr);
        panel.close.push(cArr);
        panel.volume.push(vArr);
        panel.tbv.push(tbvArr);
        panel.fundSum.push(fsArr);
        panel.fundLast.push(flArr);
      }

      const scoreBars = l1ScoreBars(panel);
      expect(scoreBars.length).toBe(1);
      expect(scoreBars[0].t).toBe(panel.t[42] + H8);
      for (const sym of symbols) {
        expect(Number.isFinite(scoreBars[0].scores[sym])).toBe(true);
      }
    });
  });
});
