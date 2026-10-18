import { describe, expect, it } from 'vitest';
import { L4_PERIOD_MS } from './candidates';
import {
  HourBar,
  l1Scores,
  l2Scores,
  l3Scores,
  l4Scores,
  L2_WEIGHTS,
  positioningZ,
  RatioPoint,
  realisedVariance168,
  rvRankComponent,
} from './factors';

describe('factor scoring functions', () => {
  const symbols = ['AAA', 'BBB', 'CCC'] as const;
  const T = Date.UTC(2026, 9, 18, 8);

  describe('L1: rv-v1 composite', () => {
    it('uses compositeZ as score, skips missing symbol with rv_skipped, and preserves symbols order', () => {
      const rvRanked = [
        { symbol: 'CCC', compositeZ: -0.42, rank: 3 },
        { symbol: 'AAA', compositeZ: 1.85, rank: 1 },
      ];

      const result = l1Scores(symbols, rvRanked);

      expect(result.scores.AAA).toBeCloseTo(1.85, 10);
      expect(result.scores.CCC).toBeCloseTo(-0.42, 10);
      expect(result.scores.BBB).toBeUndefined();

      expect(result.skipped).toEqual([{ symbol: 'BBB', reason: 'rv_skipped' }]);

      // All symbols are covered in the order of the symbols argument
      const outputSymbols = [
        ...symbols.filter((s) => s in result.scores),
        ...result.skipped.map((s) => s.symbol),
      ].sort((a, b) => symbols.indexOf(a as (typeof symbols)[number]) - symbols.indexOf(b as (typeof symbols)[number]));
      expect(outputSymbols).toEqual(['AAA', 'BBB', 'CCC']);
    });

    it('skips symbols with non-finite compositeZ', () => {
      const rvRanked = [
        { symbol: 'AAA', compositeZ: Number.NaN, rank: 1 },
        { symbol: 'BBB', compositeZ: Number.POSITIVE_INFINITY, rank: 2 },
        { symbol: 'CCC', compositeZ: 0.5, rank: 3 },
      ];

      const result = l1Scores(symbols, rvRanked);

      expect(result.scores).toEqual({ CCC: 0.5 });
      expect(result.skipped).toEqual([
        { symbol: 'AAA', reason: 'rv_skipped' },
        { symbol: 'BBB', reason: 'rv_skipped' },
      ]);
    });
  });

  describe('L2: combined v8 and rv', () => {
    it('evaluates rvRankComponent correctly for ranks 1, 10, and 5.5', () => {
      expect(rvRankComponent(1)).toBeCloseTo(100, 10);
      expect(rvRankComponent(10)).toBeCloseTo(-100, 10);
      expect(rvRankComponent(5.5)).toBeCloseTo(0, 10);
    });

    it('scores AAA with 0.5 * 40 + 0.5 * 100 = 70 using exported weights', () => {
      expect(L2_WEIGHTS.v8).toBe(0.5);
      expect(L2_WEIGHTS.rv).toBe(0.5);

      const v8Scores = { AAA: 40 };
      const rvRanked = [{ symbol: 'AAA', compositeZ: 1.2, rank: 1 }];

      const result = l2Scores(['AAA'], v8Scores, rvRanked);
      expect(result.scores.AAA).toBeCloseTo(70, 10);
      expect(result.skipped).toHaveLength(0);
    });

    it('skips with v8_missing when rank exists but v8 is null, undefined, or non-finite', () => {
      const v8Scores = { AAA: null, BBB: undefined, CCC: Number.NaN };
      const rvRanked = [
        { symbol: 'AAA', compositeZ: 0.5, rank: 2 },
        { symbol: 'BBB', compositeZ: 0.4, rank: 3 },
        { symbol: 'CCC', compositeZ: 0.3, rank: 4 },
      ];

      const result = l2Scores(symbols, v8Scores, rvRanked);
      expect(Object.keys(result.scores)).toHaveLength(0);
      expect(result.skipped).toEqual([
        { symbol: 'AAA', reason: 'v8_missing' },
        { symbol: 'BBB', reason: 'v8_missing' },
        { symbol: 'CCC', reason: 'v8_missing' },
      ]);
    });

    it('checks rank first: skips with rv_skipped when v8 is present but rank is missing', () => {
      const v8Scores = { AAA: 50 };
      const rvRanked: { symbol: string; compositeZ: number; rank: number }[] = [];

      const result = l2Scores(['AAA'], v8Scores, rvRanked);
      expect(result.scores.AAA).toBeUndefined();
      expect(result.skipped).toEqual([{ symbol: 'AAA', reason: 'rv_skipped' }]);
    });
  });

  describe('L3: variance fade', () => {
    const buildContiguousBars = (count: number, endOpenTime: number): HourBar[] => {
      return Array.from({ length: count }, (_, k) => {
        const openTime = endOpenTime - (count - 1 - k) * 3_600_000;
        return {
          openTime,
          closeTime: openTime + 3_600_000 - 1,
          close: 100 * Math.exp(0.01 * k),
        };
      });
    };

    const baseBars = buildContiguousBars(169, T - 3_600_000);

    it('computes 0.0168 realised variance and -0.0168 score for 169 exponential bars', () => {
      const variance = realisedVariance168(baseBars, T);
      expect(typeof variance).toBe('number');
      expect(variance as number).toBeCloseTo(0.0168, 12);

      const result = l3Scores(symbols, { AAA: baseBars }, T);
      expect(result.scores.AAA).toBeCloseTo(-0.0168, 12);
      expect(result.skipped).toEqual([
        { symbol: 'BBB', reason: 'bars_incomplete' },
        { symbol: 'CCC', reason: 'bars_incomplete' },
      ]);
    });

    it('returns forming_bar when a bar closes at or after T', () => {
      const formingBar: HourBar = {
        openTime: T,
        closeTime: T + 3_599_999,
        close: 100,
      };
      const barsWithForming = [...baseBars, formingBar];
      expect(realisedVariance168(barsWithForming, T)).toBe('forming_bar');

      // The boundary itself: a bar closing exactly at T is refused, so `>=` cannot regress to `>`
      const lastBar = baseBars[baseBars.length - 1];
      const closingAtT = [...baseBars.slice(0, -1), { ...lastBar, closeTime: T }];
      expect(realisedVariance168(closingAtT, T)).toBe('forming_bar');
    });

    it('returns bars_incomplete when fewer than 169 bars are provided', () => {
      const fewerBars = baseBars.slice(1);
      expect(fewerBars.length).toBe(168);
      expect(realisedVariance168(fewerBars, T)).toBe('bars_incomplete');
    });

    it('returns bars_incomplete when bars are shifted back one hour so last bar opens at T - 7_200_000', () => {
      const shiftedBars = baseBars.map((b) => ({
        openTime: b.openTime - 3_600_000,
        closeTime: b.closeTime - 3_600_000,
        close: b.close,
      }));
      expect(shiftedBars[shiftedBars.length - 1].openTime).toBe(T - 7_200_000);
      expect(realisedVariance168(shiftedBars, T)).toBe('bars_incomplete');
    });

    it('returns bars_incomplete when a close price is non-finite or non-positive', () => {
      const nonPositiveBars = baseBars.map((b, idx) =>
        idx === 10 ? { ...b, close: 0 } : b
      );
      expect(realisedVariance168(nonPositiveBars, T)).toBe('bars_incomplete');

      const nanBars = baseBars.map((b, idx) =>
        idx === 10 ? { ...b, close: Number.NaN } : b
      );
      expect(realisedVariance168(nanBars, T)).toBe('bars_incomplete');
    });

    it('returns bars_not_contiguous when consecutive open times are not 1h apart', () => {
      const middleRemoved = [...baseBars];
      middleRemoved.splice(84, 1);
      const prepended: HourBar = {
        openTime: baseBars[0].openTime - 3_600_000,
        closeTime: baseBars[0].closeTime - 3_600_000,
        close: 100 * Math.exp(-0.01),
      };
      const nonContiguousBars = [prepended, ...middleRemoved];
      expect(nonContiguousBars.length).toBe(169);
      expect(realisedVariance168(nonContiguousBars, T)).toBe('bars_not_contiguous');
    });

    it('ignores extra older bars beyond the last 169', () => {
      const olderBars: HourBar[] = Array.from({ length: 31 }, (_, i) => ({
        openTime: baseBars[0].openTime - (31 - i) * 3_600_000,
        closeTime: baseBars[0].openTime - (31 - i) * 3_600_000 + 3_599_999,
        close: 100 * Math.exp(-0.01 * (31 - i)),
      }));
      const bars200 = [...olderBars, ...baseBars];
      const variance200 = realisedVariance168(bars200, T);
      expect(typeof variance200).toBe('number');
      expect(variance200 as number).toBeCloseTo(0.0168, 12);
    });
  });

  describe('L4: positioning fade', () => {
    const basePoints: RatioPoint[] = Array.from({ length: 180 }, (_, k) => ({
      timestamp: T - (180 - k) * L4_PERIOD_MS,
      longShortRatio: 1 + 0.001 * k,
    }));

    const ratios = basePoints.map((p) => p.longShortRatio);
    const mean = ratios.reduce((sum, val) => sum + val, 0) / ratios.length;
    const variance =
      ratios.reduce((sum, val) => sum + (val - mean) ** 2, 0) / (ratios.length - 1);
    const sd = Math.sqrt(variance);
    const expectedZ = (1.179 - mean) / sd;

    it('calculates expected z-score, minus z score, and latestTimestamp === T - L4_PERIOD_MS', () => {
      const pointRes = positioningZ(basePoints, T);
      expect(typeof pointRes).toBe('object');
      if (typeof pointRes === 'object') {
        expect(pointRes.z).toBeCloseTo(expectedZ, 10);
        expect(pointRes.latestTimestamp).toBe(T - L4_PERIOD_MS);
      }

      const l4Res = l4Scores(symbols, { AAA: basePoints }, T);
      expect(l4Res.result.scores.AAA).toBeCloseTo(-expectedZ, 10);
      expect(l4Res.inputs.AAA.z).toBeCloseTo(expectedZ, 10);
      expect(l4Res.inputs.AAA.latestTimestamp).toBe(T - L4_PERIOD_MS);
      expect(l4Res.result.skipped).toEqual([
        { symbol: 'BBB', reason: 'ratio_stale' },
        { symbol: 'CCC', reason: 'ratio_stale' },
      ]);
    });

    it('ignores a point stamped exactly T (published early)', () => {
      const earlyPoint: RatioPoint = {
        timestamp: T,
        longShortRatio: 2.0,
      };
      const withEarly = [...basePoints, earlyPoint];
      const res = positioningZ(withEarly, T);
      expect(typeof res).toBe('object');
      if (typeof res === 'object') {
        expect(res.z).toBeCloseTo(expectedZ, 10);
        expect(res.latestTimestamp).toBe(T - L4_PERIOD_MS);
      }
    });

    it('ignores a point stamped T + L4_PERIOD_MS', () => {
      const futurePoint: RatioPoint = {
        timestamp: T + L4_PERIOD_MS,
        longShortRatio: 2.0,
      };
      const withFuture = [...basePoints, futurePoint];
      const res = positioningZ(withFuture, T);
      expect(typeof res).toBe('object');
      if (typeof res === 'object') {
        expect(res.z).toBeCloseTo(expectedZ, 10);
        expect(res.latestTimestamp).toBe(T - L4_PERIOD_MS);
      }
    });

    it('returns ratio_stale when points end at T - 2 * L4_PERIOD_MS', () => {
      const missingCutoff = basePoints.map((p) => ({
        timestamp: p.timestamp - L4_PERIOD_MS,
        longShortRatio: p.longShortRatio,
      }));
      expect(positioningZ(missingCutoff, T)).toBe('ratio_stale');
    });

    it('returns ratio_stale when points end at T - L4_PERIOD_MS - 1', () => {
      const offGrid = basePoints.map((p) => ({
        timestamp: p.timestamp - 1,
        longShortRatio: p.longShortRatio,
      }));
      expect(positioningZ(offGrid, T)).toBe('ratio_stale');
    });

    it('returns ratio_incomplete when fewer than 180 points are available', () => {
      const points179 = basePoints.slice(1);
      expect(points179.length).toBe(179);
      expect(positioningZ(points179, T)).toBe('ratio_incomplete');
    });

    it('returns ratio_incomplete when a ratio is non-finite or non-positive', () => {
      const zeroRatio = basePoints.map((p, idx) =>
        idx === 5 ? { ...p, longShortRatio: 0 } : p
      );
      expect(positioningZ(zeroRatio, T)).toBe('ratio_incomplete');

      const nanRatio = basePoints.map((p, idx) =>
        idx === 5 ? { ...p, longShortRatio: Number.NaN } : p
      );
      expect(positioningZ(nanRatio, T)).toBe('ratio_incomplete');
    });

    it('returns ratio_incomplete when a consecutive gap in the window is not L4_PERIOD_MS', () => {
      const middleRemoved = [...basePoints];
      middleRemoved.splice(90, 1);
      const prepended: RatioPoint = {
        timestamp: basePoints[0].timestamp - L4_PERIOD_MS,
        longShortRatio: 0.999,
      };
      const gapPoints = [prepended, ...middleRemoved];
      expect(gapPoints.length).toBe(180);
      expect(positioningZ(gapPoints, T)).toBe('ratio_incomplete');
    });

    it('returns ratio_no_spread when all ratios are equal', () => {
      const flatPoints = basePoints.map((p) => ({
        ...p,
        longShortRatio: 1.5,
      }));
      expect(positioningZ(flatPoints, T)).toBe('ratio_no_spread');
    });

    it('de-duplicates points with duplicate timestamps by keeping the last occurrence', () => {
      const withDuplicate = [
        ...basePoints.slice(0, 179),
        { timestamp: T - L4_PERIOD_MS, longShortRatio: 999 },
        { timestamp: T - L4_PERIOD_MS, longShortRatio: 1.179 },
      ];
      const res = positioningZ(withDuplicate, T);
      expect(typeof res).toBe('object');
      if (typeof res === 'object') {
        expect(res.z).toBeCloseTo(expectedZ, 10);
        expect(res.latestTimestamp).toBe(T - L4_PERIOD_MS);
      }
    });
  });
});
