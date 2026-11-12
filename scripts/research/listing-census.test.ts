// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { KlineCsvRow } from '@/lib/external/binance-archive';

import { HOUR_MS, MAINTENANCE_MARGIN } from './carry-sim';
import { quantile, type ScoutSettlement } from './funding-scout';
import {
  buildPosition,
  CENSUS_COSTS,
  costNet,
  isLeftCensored,
  listingTime,
  monthsForPosition,
  summariseCohort,
  type CohortPositionInput,
} from './listing-census';

describe('isLeftCensored', () => {
  it('a listing at Date.UTC(2020,0,2) is true, one at Date.UTC(2020,0,3) is false', () => {
    expect(isLeftCensored(Date.UTC(2020, 0, 2))).toBe(true);
    expect(isLeftCensored(Date.UTC(2020, 0, 3))).toBe(false);
  });
});

describe('listingTime', () => {
  it('returns the open time of the first bar', () => {
    const bars: KlineCsvRow[] = [
      {
        timestamp: Date.UTC(2021, 5, 1, 8),
        open: 10,
        high: 11,
        low: 9,
        close: 10.5,
        volume: 100,
        quoteVolume: 1000,
        trades: 10,
        takerBuyVolume: null,
      },
    ];
    expect(listingTime(bars)).toBe(Date.UTC(2021, 5, 1, 8));
  });

  it('returns null for empty bars', () => {
    expect(listingTime([])).toBeNull();
  });
});

describe('buildPosition', () => {
  it('on synthetic 1h series with linear rise over 60 days, N=7, H=30 matches hand calculation to 1e-12', () => {
    const L = Date.UTC(2021, 0, 1, 0, 0, 0);
    // 60 days = 1440 1h bars.
    // Price 100 at listing, linear rise to 130 over 60 days. high = close * 1.01.
    const bars: KlineCsvRow[] = [];
    for (let i = 0; i < 1440; i++) {
      const timestamp = L + i * HOUR_MS;
      const open = 100 + (30 * i) / 1440;
      const close = 100 + (30 * (i + 1)) / 1440;
      const high = close * 1.01;
      const low = open;
      bars.push({
        timestamp,
        open,
        high,
        low,
        close,
        volume: 100,
        quoteVolume: 10000,
        trades: 10,
        takerBuyVolume: null,
      });
    }

    // Settlements every 8 hours with rate +0.0001
    const settlements: ScoutSettlement[] = [];
    for (let t = L; t <= L + 1440 * HOUR_MS; t += 8 * HOUR_MS) {
      settlements.push({
        t,
        rate: 0.0001,
        intervalHours: 8,
        r8: 0.0001,
      });
    }

    const pos = buildPosition(bars, settlements, L, 7, 30);
    expect(pos.status).toBe('ok');
    if (pos.status !== 'ok') throw new Error('expected status ok');

    // N=7d -> L + 7*24h = L + 168h -> bar i=168
    const expectedEntryT = L + 168 * HOUR_MS;
    expect(pos.entryT).toBe(expectedEntryT);

    // H=30d -> entryT + 30*24h = L + (168 + 720)h = L + 888h
    // Last bar with open time < entry + 30d is i=887 (open L + 887h, close L + 888h)
    const expectedExitT = L + 888 * HOUR_MS;
    expect(pos.exitT).toBe(expectedExitT);

    const entryOpen = 100 + (30 * 168) / 1440; // 103.5
    const exitClose = 100 + (30 * 888) / 1440; // 118.5
    const expectedPriceReturn = -(exitClose / entryOpen - 1);
    expect(pos.priceReturn).toBeCloseTo(expectedPriceReturn, 12);

    // Settlements with entryT < t <= exitT: k=22 to k=111 inclusive -> 90 settlements
    const settlementCount = 90;
    const expectedFunding = 0.0001 * settlementCount;
    expect(pos.funding).not.toBeNull();
    expect(pos.funding!).toBeCloseTo(expectedFunding, 12);

    // Max high in hold is at the last bar i=887
    const maxHigh = exitClose * 1.01;
    const expectedSqueeze = maxHigh / entryOpen - 1;
    expect(pos.squeeze).toBeCloseTo(expectedSqueeze, 12);

    expect(pos.delisted).toBe(false);
    expect(pos.liquidated1x).toBe(false);
  });

  it('a series that ends before the exit gives delisted: true and closes at the last bar', () => {
    const L = Date.UTC(2021, 0, 1, 0, 0, 0);
    // 20 days of bars (480 hours)
    const bars: KlineCsvRow[] = [];
    for (let i = 0; i < 480; i++) {
      bars.push({
        timestamp: L + i * HOUR_MS,
        open: 100,
        high: 102,
        low: 98,
        close: 101,
        volume: 10,
        quoteVolume: 1000,
        trades: 1,
        takerBuyVolume: null,
      });
    }
    const settlements: ScoutSettlement[] = [];

    // N=7d, H=30d -> requires 37d, but series only has 20d
    const pos = buildPosition(bars, settlements, L, 7, 30);
    expect(pos.status).toBe('ok');
    if (pos.status !== 'ok') throw new Error('expected status ok');

    expect(pos.delisted).toBe(true);
    // Last bar is i=479 (open L + 479h, close L + 480h)
    expect(pos.exitT).toBe(L + 480 * HOUR_MS);
    expect(pos.exitClose).toBe(101);
  });

  it('a window reaching 2024-07-01 returns truncatedAtCutoff as a tagged result without throwing', () => {
    // Listing in June 2024, N=1, H=30 -> exit reaches July 2024 (>= 2024-07-01)
    const L = Date.UTC(2024, 5, 2, 0, 0, 0); // June 2, 2024
    const bars: KlineCsvRow[] = [
      {
        timestamp: L,
        open: 50,
        high: 51,
        low: 49,
        close: 50.5,
        volume: 10,
        quoteVolume: 500,
        trades: 1,
        takerBuyVolume: null,
      },
      {
        timestamp: L + 24 * HOUR_MS,
        open: 50,
        high: 51,
        low: 49,
        close: 50.5,
        volume: 10,
        quoteVolume: 500,
        trades: 1,
        takerBuyVolume: null,
      },
    ];

    const pos = buildPosition(bars, [], L, 1, 30);
    expect(pos).toEqual({ status: 'truncatedAtCutoff' });
  });

  it('liquidated1x is true when the high reaches 2 x entryOpen and false at 1.9 x', () => {
    const L = Date.UTC(2022, 0, 1, 0, 0, 0);

    // 10 days of bars (N=1, H=5)
    function makeBars(peakHigh: number): KlineCsvRow[] {
      const result: KlineCsvRow[] = [];
      for (let i = 0; i < 240; i++) {
        const timestamp = L + i * HOUR_MS;
        const open = 100;
        const close = 100;
        const high = i === 40 ? peakHigh : 100;
        result.push({
          timestamp,
          open,
          high,
          low: 100,
          close,
          volume: 1,
          quoteVolume: 100,
          trades: 1,
          takerBuyVolume: null,
        });
      }
      return result;
    }

    // Peak high reaches 2 * entryOpen = 200 -> maxHigh / entryOpen - 1 = 1.0 >= 1 - MAINTENANCE_MARGIN (0.995)
    const posLiq = buildPosition(makeBars(200), [], L, 1, 5);
    expect(posLiq.status).toBe('ok');
    if (posLiq.status !== 'ok') throw new Error('expected ok');
    expect(posLiq.liquidated1x).toBe(true);

    // Peak high is 1.9 * entryOpen = 190 -> 0.90 < 0.995
    const posSafe = buildPosition(makeBars(190), [], L, 1, 5);
    expect(posSafe.status).toBe('ok');
    if (posSafe.status !== 'ok') throw new Error('expected ok');
    expect(posSafe.liquidated1x).toBe(false);

    // Boundary check at exactly (1 - MAINTENANCE_MARGIN) * entryOpen + entryOpen = (2 - 0.005) * 100 = 199.5
    expect(1 - MAINTENANCE_MARGIN).toBe(0.995);
  });
});

describe('costNet', () => {
  it('deducts exact profile costs from gross return', () => {
    const gross = 0.05;
    expect(costNet(gross, 'taker')).toBeCloseTo(0.05 - CENSUS_COSTS.taker, 12);
    expect(costNet(gross, 'maker')).toBeCloseTo(0.05 - CENSUS_COSTS.maker, 12);
    expect(costNet(gross, 'taker+10bps')).toBeCloseTo(0.05 - CENSUS_COSTS['taker+10bps'], 12);
  });
});

describe('summariseCohort', () => {
  it('returns only n when n < 5', () => {
    const fourPositions: CohortPositionInput[] = [
      { priceReturn: -0.01, funding: 0.001, squeeze: 0.05, liquidated1x: false, delisted: false },
      { priceReturn: -0.02, funding: 0.002, squeeze: 0.06, liquidated1x: false, delisted: false },
      { priceReturn: 0.01, funding: 0.001, squeeze: 0.04, liquidated1x: false, delisted: false },
      { priceReturn: 0.03, funding: 0.001, squeeze: 0.03, liquidated1x: false, delisted: false },
    ];
    expect(summariseCohort(fourPositions)).toEqual({ n: 4 });
  });

  it('computes exact hand values for a 6-position fixture', () => {
    // 6 positions with chosen gross returns such that net taker values are:
    // [-0.05, -0.01, 0.02, 0.04, 0.06, 0.10]
    // Since net taker = gross - 0.0016 and gross = priceReturn + (funding ?? 0),
    // we need priceReturn = netTaker + 0.0016 - (funding ?? 0).
    const netTakerTargets = [-0.05, -0.01, 0.02, 0.04, 0.06, 0.1];
    const squeezes = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3];

    const sixPositions: CohortPositionInput[] = netTakerTargets.map((net, i) => {
      const funding = i === 4 ? null : 0.001;
      return {
        priceReturn: net + 0.0016 - (funding ?? 0),
        funding,
        squeeze: squeezes[i],
        liquidated1x: i === 5,
        delisted: i === 3,
      };
    });

    const summary = summariseCohort(sixPositions);
    expect(summary.n).toBe(6);
    if (!('netTaker' in summary)) throw new Error('expected full cohort summary');

    // Hand calculations:
    // Sorted net taker: [-0.05, -0.01, 0.02, 0.04, 0.06, 0.10]
    // mean: (-0.05 - 0.01 + 0.02 + 0.04 + 0.06 + 0.10) / 6 = 0.16 / 6 = 0.02666666666666667
    expect(summary.netTaker.mean).toBeCloseTo(0.16 / 6, 12);
    expect(summary.meanNetTaker).toBeCloseTo(0.16 / 6, 12);

    // median: pos = 0.5 * 5 = 2.5 -> 0.02 + 0.5 * (0.04 - 0.02) = 0.03
    expect(summary.netTaker.median).toBeCloseTo(0.03, 12);
    expect(summary.medianNetTaker).toBeCloseTo(0.03, 12);

    // share positive: 4 of 6 are > 0 -> 4/6 = 2/3
    expect(summary.sharePositive).toBeCloseTo(4 / 6, 12);
    expect(summary.netTaker.sharePositive).toBeCloseTo(4 / 6, 12);

    // p10: pos = 0.1 * 5 = 0.5 -> -0.05 + 0.5 * (-0.01 - (-0.05)) = -0.03
    expect(summary.netTaker.p10).toBeCloseTo(-0.03, 12);
    expect(summary.p10NetTaker).toBeCloseTo(-0.03, 12);

    // p90: pos = 0.9 * 5 = 4.5 -> 0.06 + 0.5 * (0.10 - 0.06) = 0.08
    expect(summary.netTaker.p90).toBeCloseTo(0.08, 12);
    expect(summary.p90NetTaker).toBeCloseTo(0.08, 12);

    // Check quantile directly
    expect(quantile(netTakerTargets, 0.5)).toBeCloseTo(0.03, 12);
    expect(quantile(netTakerTargets, 0.1)).toBeCloseTo(-0.03, 12);
    expect(quantile(netTakerTargets, 0.9)).toBeCloseTo(0.08, 12);

    // Counts
    expect(summary.liquidated1x).toBe(1);
    expect(summary.delisted).toBe(1);
    expect(summary.noFunding).toBe(1);
  });
});

describe('monthsForPosition', () => {
  it('returns no month after 2024-06 and throws when asked for 2024-07', () => {
    // January 2024 for 30 days -> within 2024-01
    const safeMonths = monthsForPosition(Date.UTC(2024, 0, 1), 30);
    expect(safeMonths.every((m) => m <= '2024-06')).toBe(true);
    expect(safeMonths).toEqual(['2024-01']);

    // A request touching 2024-07 throws through assertMonthAllowed
    expect(() => monthsForPosition(Date.UTC(2024, 5, 15), 30)).toThrow(
      /data discipline: month 2024-07 is after 2024-06/
    );
  });
});
