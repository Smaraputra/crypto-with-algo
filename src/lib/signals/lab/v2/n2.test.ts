import { describe, expect, it } from 'vitest';
import {
  prepareDataset as prepareResearchDataset,
  walkForward,
  NV1_SYMBOLS,
} from '../../../../../scripts/research/nv1-c2';
import { createSeededRandom } from '@/lib/stats/seeded-random';
import { rankWeightedCorrelation } from '@/lib/stats/rank-ic';
import {
  Bar1d,
  computeTurnover,
  DAY_MS,
  N2,
  n2BookAt,
  n2HistoryNeeded,
} from './n2';

interface SyntheticBar extends Bar1d {
  tbv: number;
}

function generateSyntheticDataset(): Record<string, SyntheticBar[]> {
  const rng = createSeededRandom(42);
  const startT = Date.UTC(2015, 0, 5); // 2015-01-05 Monday
  const numDays = 2800; // ~7.66 years

  const candles: Record<string, SyntheticBar[]> = {};
  const prices: Record<string, number> = {};

  for (const sym of NV1_SYMBOLS) {
    candles[sym] = [];
    prices[sym] = 100 + rng() * 50;
  }

  for (let d = 0; d < numDays; d++) {
    const t = startT + d * DAY_MS;
    // Market common factor return
    const rCommon = (rng() - 0.495) * 0.025;

    for (const sym of NV1_SYMBOLS) {
      const rIdio = (rng() - 0.495) * 0.035;
      const rTotal = rCommon + rIdio;
      const prevClose = prices[sym];
      const close = Math.max(1.0, prevClose * (1 + rTotal));
      prices[sym] = close;

      const open = prevClose * (1 + (rng() - 0.5) * 0.008);
      const high = Math.max(open, close) * (1 + rng() * 0.012);
      const low = Math.min(open, close) * (1 - rng() * 0.012);
      const v = 5000 + rng() * 20000;
      const tbv = v * (0.35 + 0.3 * rng());

      candles[sym].push({
        t,
        o: open,
        h: high,
        l: low,
        c: close,
        v,
        tbv,
      });
    }
  }

  // Delete a few random days for two coins to exercise missing-data paths
  // Choose ADAUSDT and LINKUSDT
  // Day 500, 1000, 1500 are in earlier training history.
  // Day 2666 is Sunday (M + 6d) of week 60 (day 2660), where ADAUSDT is eligible.
  // Deleting day 2666 makes ADAUSDT's rawForwardReturn null, exercising the incomplete week path.
  const daysToDeleteAda = [500, 1000, 1500, 2666];
  const daysToDeleteLink = [600, 1100, 1600, 2450];

  const adaSet = new Set(daysToDeleteAda.map((d) => startT + d * DAY_MS));
  const linkSet = new Set(daysToDeleteLink.map((d) => startT + d * DAY_MS));

  candles['ADAUSDT'] = candles['ADAUSDT'].filter((b) => !adaSet.has(b.t));
  candles['LINKUSDT'] = candles['LINKUSDT'].filter((b) => !linkSet.has(b.t));

  return candles;
}

describe('lab-v2 N2 live scorer', () => {
  const candles = generateSyntheticDataset();
  const researchPrepared = prepareResearchDataset(candles);

  const allWeeks = researchPrepared.weeks.map((w) => w.M);
  const last80Weeks = allWeeks.slice(-80);
  const testStart = last80Weeks[0];
  const testEnd = last80Weeks[last80Weeks.length - 1];

  it('matches Round 1 screen walkForward over the last 80 weeks (parity test)', () => {
    const wfResults = walkForward(researchPrepared, 260, 1, { testStart, testEnd });
    expect(wfResults.length).toBe(80);

    let prevLiveWeights = new Map<string, number>();
    let observedIncomplete = 0;
    let observedCash = 0;
    let observedOk = 0;

    for (let i = 0; i < wfResults.length; i++) {
      const wf = wfResults[i];
      const M = wf.M;
      const book = n2BookAt(candles, M);

      expect(book.M).toBe(M);

      if (book.cash) {
        observedCash++;
        const currentWeights = new Map<string, number>();
        const turnover = computeTurnover(prevLiveWeights, currentWeights);
        const cost = N2.costRate * turnover;
        const net = -cost;
        const ic = Number.NaN;
        prevLiveWeights = currentWeights;

        expect(wf.cash).toBe(true);
        expect(wf.eligible).toBe(book.eligible.length);
        expect(Math.abs(wf.turnover! - turnover)).toBeLessThan(1e-12);
        expect(Math.abs(wf.net - net)).toBeLessThan(1e-12);
        expect(Number.isNaN(wf.ic)).toBe(true);
        expect(Number.isNaN(ic)).toBe(true);
        continue;
      }

      // Check whether forward returns are complete for this week
      let gross = 0;
      const eligibleRawReturns: number[] = [];
      let returnsComplete = true;

      for (const sym of book.eligible) {
        const rawRet = researchPrepared.byM.get(M)?.coinData.get(sym)?.rawForwardReturn;
        if (rawRet === null || rawRet === undefined || !Number.isFinite(rawRet)) {
          returnsComplete = false;
          break;
        }
        eligibleRawReturns.push(rawRet);
        gross += (book.weights[sym] ?? 0) * rawRet;
      }

      if (!returnsComplete) {
        observedIncomplete++;
        const currentWeights = new Map<string, number>();
        const turnover = computeTurnover(prevLiveWeights, currentWeights);
        const cost = N2.costRate * turnover;
        const net = -cost;
        const ic = Number.NaN;
        prevLiveWeights = currentWeights;

        expect(wf.cash).toBe(false);
        expect(wf.incomplete).toBe(true);
        expect(wf.eligible).toBe(book.eligible.length);
        expect(Math.abs(wf.turnover! - turnover)).toBeLessThan(1e-12);
        expect(Math.abs(wf.net - net)).toBeLessThan(1e-12);
        expect(Number.isNaN(wf.ic)).toBe(true);
        expect(Number.isNaN(ic)).toBe(true);
        continue;
      }

      observedOk++;
      const currentWeights = new Map<string, number>();
      for (const sym of book.eligible) {
        currentWeights.set(sym, book.weights[sym]);
      }
      const turnover = computeTurnover(prevLiveWeights, currentWeights);
      const cost = N2.costRate * turnover;
      const net = gross - cost;
      const eligiblePreds = book.eligible.map((sym) => book.predictions[sym]);
      const ic = rankWeightedCorrelation(eligiblePreds, eligibleRawReturns);
      prevLiveWeights = currentWeights;

      expect(wf.cash).toBe(false);
      expect(wf.incomplete).toBe(false);
      expect(wf.eligible).toBe(book.eligible.length);
      expect(Math.abs(wf.turnover! - turnover)).toBeLessThan(1e-12);
      expect(Math.abs(wf.net - net)).toBeLessThan(1e-12);
      if (Number.isNaN(wf.ic)) {
        expect(Number.isNaN(ic)).toBe(true);
      } else {
        expect(Math.abs(wf.ic - ic)).toBeLessThan(1e-12);
      }
    }

    expect(observedOk).toBeGreaterThan(0);
    expect(observedCash).toBeGreaterThan(0);
    expect(observedIncomplete).toBeGreaterThan(0);
  });

  it('look-ahead: appending a far-out bar with t >= M does not change n2BookAt(candles, M)', () => {
    const testM = last80Weeks[40];
    const bookBefore = n2BookAt(candles, testM);

    // Create cloned candles with an appended bar at t >= testM
    const candlesWithFarOut: Record<string, Bar1d[]> = {};
    for (const sym of NV1_SYMBOLS) {
      candlesWithFarOut[sym] = [
        ...candles[sym],
        {
          t: testM + DAY_MS,
          o: 999999,
          h: 999999,
          l: 999999,
          c: 999999,
          v: 999999,
          tbv: 500000,
        },
        {
          t: testM + 10 * DAY_MS,
          o: 888888,
          h: 888888,
          l: 888888,
          c: 888888,
          v: 888888,
          tbv: 444444,
        },
      ];
    }

    const bookAfter = n2BookAt(candlesWithFarOut, testM);
    expect(bookAfter).toEqual(bookBefore);
  });

  it('history: n2HistoryNeeded(M).endTime === M - 1 and truncating candles leaves the book unchanged', () => {
    const testM = last80Weeks[50];
    const { startTime, endTime } = n2HistoryNeeded(testM);

    expect(endTime).toBe(testM - 1);

    const bookFull = n2BookAt(candles, testM);

    const truncatedCandles: Record<string, Bar1d[]> = {};
    for (const sym of NV1_SYMBOLS) {
      truncatedCandles[sym] = candles[sym].filter((b) => b.t >= startTime && b.t <= endTime);
    }

    const bookTruncated = n2BookAt(truncatedCandles, testM);
    expect(bookTruncated).toEqual(bookFull);
  });
});
