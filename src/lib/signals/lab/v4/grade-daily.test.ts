// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  LAB_HYPOTHESES_V4_DAILY,
  LAB_V4_DAILY_SCALE,
  LAB_V4_ROUND_TRIP,
} from '@/lib/signals/lab/candidates';
import { initialEState, type EProcessState } from '@/lib/signals/lab/e-process';
import {
  dailyBookReturn,
  gradeDailyBar,
  type DailyFundingSettlement,
  type DailyTrade,
} from './grade-daily';

describe('grade-daily', () => {
  const S1_DAILY = LAB_HYPOTHESES_V4_DAILY[0];
  const S2_DAILY = LAB_HYPOTHESES_V4_DAILY[1];

  it('grades a trade inside one day', () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const entryTime = dayStart + 10 * 3600_000 + 10 * 60_000; // 10:10 UTC
    const exitTime = entryTime + 8 * 3600_000; // 18:10 UTC

    const trade: DailyTrade = {
      symbol: 'BTCUSDT',
      side: 1,
      entryTime,
      exitTime,
      barClose: dayStart + 10 * 3600_000,
    };

    const prices5m = {
      BTCUSDT: {
        [entryTime]: 100,
        [exitTime]: 102,
      },
    };

    const settlements: DailyFundingSettlement[] = [
      {
        symbol: 'BTCUSDT',
        fundingTime: dayStart + 16 * 3600_000, // 16:00 UTC, inside window
        rate: 0.0001,
      },
    ];

    const expectedGross = 1 * Math.log(102 / 100);
    const expectedCost = LAB_V4_ROUND_TRIP;
    const expectedFunding = 1 * 0.0001;
    const expectedR = expectedGross - expectedCost - expectedFunding;
    const expectedX = Math.min(expectedR / LAB_V4_DAILY_SCALE.S1, 1);

    const ret = dailyBookReturn([trade], prices5m, settlements, dayStart);
    expect(ret.R_d).toBeCloseTo(expectedR, 12);
    expect(ret.gross).toBeCloseTo(expectedGross, 12);
    expect(ret.cost).toBeCloseTo(expectedCost, 12);
    expect(ret.funding).toBeCloseTo(expectedFunding, 12);
    expect(ret.parts).toHaveLength(1);

    const gradedAt = new Date(dayStart + 86_400_000 + 3600_000);
    const row = gradeDailyBar({
      hypothesis: S1_DAILY,
      dayStart,
      trades: [trade],
      prices5m,
      settlements,
      prev: { state: initialEState() },
      gradedAt,
    });

    expect(row.version).toBe('lab-v4');
    expect(row.hypothesis).toBe('S1-1h-daily');
    expect(row.barClose).toBe(dayStart);
    expect(row.bet).toBe(true);
    expect(row.b).toBe(0);
    expect(row.n).toBe(1);
    expect(row.netBookReturn).toBeCloseTo(expectedR, 12);
    expect(row.x).toBeCloseTo(expectedX, 12);
    const expectedKey = `BTCUSDT@${entryTime}`;
    expect(row.prices[expectedKey]).toEqual({ start: 100, end: 102 });
    expect(row.weights).toEqual({ [expectedKey]: 1 });
    expect(row.funding).toEqual({ [expectedKey]: expectedFunding });
  });

  it('trade spanning midnight: the two days parts sum to side x ln(exit / entry) minus cost and funding', () => {
    const day1Start = Date.UTC(2026, 9, 25, 0, 0, 0);
    const day2Start = day1Start + 86_400_000;
    const entryTime = day1Start + 20 * 3600_000 + 10 * 60_000; // 20:10 UTC on day 1
    const exitTime = entryTime + 8 * 3600_000; // 04:10 UTC on day 2

    const tradeLong: DailyTrade = {
      symbol: 'BTCUSDT',
      side: 1,
      entryTime,
      exitTime,
      barClose: day1Start + 20 * 3600_000,
    };

    const P_entry = 100;
    const P_mid = 101.5;
    const P_exit = 104;

    const prices5m = {
      BTCUSDT: {
        [entryTime]: P_entry,
        [day2Start]: P_mid,
        [exitTime]: P_exit,
      },
    };

    const settlementDay1: DailyFundingSettlement = {
      symbol: 'BTCUSDT',
      fundingTime: day2Start, // 24:00 UTC on day 1 (00:00 UTC day 2)
      rate: 0.0002,
    };
    const settlementDay2: DailyFundingSettlement = {
      symbol: 'BTCUSDT',
      fundingTime: day2Start + 4 * 3600_000, // 04:00 UTC on day 2
      rate: 0.0003,
    };

    const allSettlements = [settlementDay1, settlementDay2];

    const retDay1 = dailyBookReturn([tradeLong], prices5m, allSettlements, day1Start);
    const retDay2 = dailyBookReturn([tradeLong], prices5m, allSettlements, day2Start);

    expect(retDay1.cost).toBeCloseTo(LAB_V4_ROUND_TRIP, 12);
    expect(retDay2.cost).toBe(0);

    expect(retDay1.funding).toBeCloseTo(0.0002, 12);
    expect(retDay2.funding).toBeCloseTo(0.0003, 12);

    const totalSum = retDay1.R_d + retDay2.R_d;
    const totalExpected =
      1 * Math.log(P_exit / P_entry) - LAB_V4_ROUND_TRIP - (0.0002 + 0.0003);

    expect(totalSum).toBeCloseTo(totalExpected, 12);

    // Also test short side
    const tradeShort: DailyTrade = {
      symbol: 'BTCUSDT',
      side: -1,
      entryTime,
      exitTime,
      barClose: day1Start + 20 * 3600_000,
    };

    const retDay1Short = dailyBookReturn([tradeShort], prices5m, allSettlements, day1Start);
    const retDay2Short = dailyBookReturn([tradeShort], prices5m, allSettlements, day2Start);

    const totalSumShort = retDay1Short.R_d + retDay2Short.R_d;
    const totalExpectedShort =
      -1 * Math.log(P_exit / P_entry) - LAB_V4_ROUND_TRIP - (-1 * (0.0002 + 0.0003));

    expect(totalSumShort).toBeCloseTo(totalExpectedShort, 12);
  });

  it('respects funding sign and window boundaries', () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const dayEnd = dayStart + 86_400_000;
    const entryTime = dayStart + 4 * 3600_000; // 04:00 UTC
    const exitTime = entryTime + 8 * 3600_000; // 12:00 UTC

    const tradeLong: DailyTrade = {
      symbol: 'ETHUSDT',
      side: 1,
      entryTime,
      exitTime,
    };
    const tradeShort: DailyTrade = {
      symbol: 'ETHUSDT',
      side: -1,
      entryTime,
      exitTime,
    };

    const prices5m = {
      ETHUSDT: {
        [entryTime]: 2000,
        [exitTime]: 2000,
      },
    };

    // Settlements:
    // 1. Exactly at entryTime (04:00): window is (entryTime, exitTime], so 04:00 is outside
    // 2. Exactly at exitTime (12:00): inside
    // 3. At 16:00 (after exit): outside
    // 4. At dayStart (00:00): window is (dayStart, dayEnd], so 00:00 is outside
    // 5. At dayEnd (24:00): window is inside day, but after exitTime (12:00), so outside
    const settlements: DailyFundingSettlement[] = [
      { symbol: 'ETHUSDT', fundingTime: entryTime, rate: 0.001 },
      { symbol: 'ETHUSDT', fundingTime: exitTime, rate: 0.0005 },
      { symbol: 'ETHUSDT', fundingTime: exitTime + 4 * 3600_000, rate: 0.001 },
      { symbol: 'ETHUSDT', fundingTime: dayStart, rate: 0.001 },
      { symbol: 'ETHUSDT', fundingTime: dayEnd, rate: 0.001 },
    ];

    const retLong = dailyBookReturn([tradeLong], prices5m, settlements, dayStart);
    // Long pays positive rate: funding deducted is +1 * 0.0005
    expect(retLong.funding).toBeCloseTo(0.0005, 12);
    expect(retLong.gross).toBeCloseTo(0, 12);
    expect(retLong.R_d).toBeCloseTo(-LAB_V4_ROUND_TRIP - 0.0005, 12);

    const retShort = dailyBookReturn([tradeShort], prices5m, settlements, dayStart);
    // Short receives positive rate: funding deducted is -1 * 0.0005 = -0.0005
    expect(retShort.funding).toBeCloseTo(-0.0005, 12);
    expect(retShort.gross).toBeCloseTo(0, 12);
    expect(retShort.R_d).toBeCloseTo(-LAB_V4_ROUND_TRIP - (-0.0005), 12);

    // Negative funding rate: longs receive
    const negSettlement: DailyFundingSettlement[] = [
      { symbol: 'ETHUSDT', fundingTime: exitTime, rate: -0.0008 },
    ];
    const retLongNeg = dailyBookReturn([tradeLong], prices5m, negSettlement, dayStart);
    expect(retLongNeg.funding).toBeCloseTo(-0.0008, 12);
    expect(retLongNeg.R_d).toBeCloseTo(-LAB_V4_ROUND_TRIP - (-0.0008), 12);
  });

  it('a no-trade day places no bet', () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const prices5m = {};
    const settlements: DailyFundingSettlement[] = [];

    const ret = dailyBookReturn([], prices5m, settlements, dayStart);
    expect(ret.R_d).toBe(0);
    expect(ret.parts).toHaveLength(0);

    const prevState = initialEState();
    const row = gradeDailyBar({
      hypothesis: S1_DAILY,
      dayStart,
      trades: [],
      prices5m,
      settlements,
      prev: { state: prevState },
      gradedAt: new Date(dayStart + 86_400_000),
    });

    expect(row.bet).toBe(false);
    expect(row.noBetReason).toBe('no_position');
    expect(row.n).toBe(0);
    expect(row.x).toBeNull();
    expect(row.b).toBeNull();
    expect(row.netBookReturn).toBeNull();
    expect(row.state).toEqual(prevState);
  });

  it('x clipped at 1, and a loss below -2 absorbs', () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const entryTime = dayStart + 3600_000;
    const exitTime = entryTime + 8 * 3600_000;

    // Huge gain: price goes from 100 to 150 (+40.5% log return), scale is 0.19
    const hugeGainTrade: DailyTrade = {
      symbol: 'BTCUSDT',
      side: 1,
      entryTime,
      exitTime,
    };
    const hugeGainPrices = {
      BTCUSDT: {
        [entryTime]: 100,
        [exitTime]: 150,
      },
    };

    const rowHugeGain = gradeDailyBar({
      hypothesis: S1_DAILY,
      dayStart,
      trades: [hugeGainTrade],
      prices5m: hugeGainPrices,
      settlements: [],
      prev: { state: initialEState() },
      gradedAt: new Date(dayStart + 86_400_000),
    });

    // R_d is ln(1.5) - 0.0014 = ~0.404, divided by 0.19 is ~2.12 > 1
    expect(rowHugeGain.netBookReturn).toBeGreaterThan(0.4);
    expect(rowHugeGain.x).toBe(1); // clipped at 1

    // Build a warmed-up state with 30 positive bets so lambda is at cap (0.5)
    let warmedState: EProcessState = initialEState();
    for (let i = 0; i < 30; i++) {
      const tradeDayStart = dayStart + i * 86_400_000;
      const tEntry = tradeDayStart + 3600_000;
      const tExit = tEntry + 8 * 3600_000;
      const stepTrade: DailyTrade = {
        symbol: 'BTCUSDT',
        side: 1,
        entryTime: tEntry,
        exitTime: tExit,
      };
      const stepPrices = {
        BTCUSDT: {
          [tEntry]: 100,
          [tExit]: 150,
        },
      };
      const stepRow = gradeDailyBar({
        hypothesis: S2_DAILY,
        dayStart: tradeDayStart,
        trades: [stepTrade],
        prices5m: stepPrices,
        settlements: [],
        prev: { state: warmedState },
        gradedAt: new Date(tradeDayStart + 86_400_000),
      });
      warmedState = stepRow.state;
    }
    expect(warmedState.n).toBe(30);

    // Large loss beyond -2:
    // Scale for S2 is 0.18, so R_d below -0.36 produces x < -2.
    // Price drops from 100 to 60 -> ln(60/100) = -0.5108.
    // -0.5108 / 0.18 = -2.838 < -2.
    const crashTrade: DailyTrade = {
      symbol: 'BTCUSDT',
      side: 1,
      entryTime: dayStart + 31 * 86_400_000 + 3600_000,
      exitTime: dayStart + 31 * 86_400_000 + 9 * 3600_000,
    };
    const crashPrices = {
      BTCUSDT: {
        [crashTrade.entryTime]: 100,
        [crashTrade.exitTime]: 60,
      },
    };

    const crashRow = gradeDailyBar({
      hypothesis: S2_DAILY,
      dayStart: dayStart + 31 * 86_400_000,
      trades: [crashTrade],
      prices5m: crashPrices,
      settlements: [],
      prev: { state: warmedState },
      gradedAt: new Date(dayStart + 32 * 86_400_000),
    });

    expect(crashRow.x).toBeLessThan(-2);
    expect(crashRow.state.absorbed).toBe(true);
    expect(crashRow.state.logE).toBe(-Infinity);

    // Subsequent bar with absorbed state ceases betting
    const subsequentRow = gradeDailyBar({
      hypothesis: S2_DAILY,
      dayStart: dayStart + 32 * 86_400_000,
      trades: [hugeGainTrade],
      prices5m: hugeGainPrices,
      settlements: [],
      prev: { state: crashRow.state },
      gradedAt: new Date(dayStart + 33 * 86_400_000),
    });

    expect(subsequentRow.bet).toBe(false);
    expect(subsequentRow.noBetReason).toBe('absorbed');
    expect(subsequentRow.lambda).toBe(0);
    expect(subsequentRow.state.absorbed).toBe(true);
  });

  it('coin with two trades in one day has two keys in weights, prices and funding', () => {
    const dayStart = Date.UTC(2026, 9, 25, 0, 0, 0);
    const entry1 = dayStart + 2 * 3600_000 + 10 * 60_000; // 02:10 UTC
    const exit1 = entry1 + 8 * 3600_000; // 10:10 UTC
    const entry2 = dayStart + 12 * 3600_000 + 10 * 60_000; // 12:10 UTC
    const exit2 = entry2 + 8 * 3600_000; // 20:10 UTC

    const trade1: DailyTrade = {
      symbol: 'BTCUSDT',
      side: 1,
      entryTime: entry1,
      exitTime: exit1,
    };
    const trade2: DailyTrade = {
      symbol: 'BTCUSDT',
      side: -1,
      entryTime: entry2,
      exitTime: exit2,
    };

    const prices5m = {
      BTCUSDT: {
        [entry1]: 100,
        [exit1]: 105,
        [entry2]: 106,
        [exit2]: 101,
      },
    };

    const settlements: DailyFundingSettlement[] = [
      {
        symbol: 'BTCUSDT',
        fundingTime: dayStart + 8 * 3600_000,
        rate: 0.0001,
      },
      {
        symbol: 'BTCUSDT',
        fundingTime: dayStart + 16 * 3600_000,
        rate: 0.0002,
      },
    ];

    const row = gradeDailyBar({
      hypothesis: S1_DAILY,
      dayStart,
      trades: [trade1, trade2],
      prices5m,
      settlements,
      prev: { state: initialEState() },
      gradedAt: new Date(dayStart + 86_400_000),
    });

    const key1 = `BTCUSDT@${entry1}`;
    const key2 = `BTCUSDT@${entry2}`;

    expect(Object.keys(row.weights ?? {})).toHaveLength(2);
    expect(row.weights?.[key1]).toBe(1);
    expect(row.weights?.[key2]).toBe(-1);

    expect(row.prices[key1]).toEqual({ start: 100, end: 105 });
    expect(row.prices[key2]).toEqual({ start: 106, end: 101 });

    expect(row.funding?.[key1]).toBeCloseTo(1 * 0.0001, 12);
    expect(row.funding?.[key2]).toBeCloseTo(-1 * 0.0002, 12);
  });
});
