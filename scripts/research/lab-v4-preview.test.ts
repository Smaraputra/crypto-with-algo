import { describe, expect, it } from 'vitest';
import type { OHLCV } from '../../src/types/market';
import type { MetricsRow } from './dataset-format';
import {
  betSeries,
  c1Signals,
  c2Signals,
  c7Signals,
  C7_FUNDING_BASELINE,
  C7_OI_LAG_MS,
  C7_OI_LOOKBACK_MS,
  C7_OI_MAX_STALENESS_MS,
  CANDIDATES,
  countGapSkips,
  decideSlots,
  DECISION_FLOOR,
  figureOf,
  HOUR_MS,
  nullSim,
  powerSim,
  previewCandidates,
  ROUND_TRIP_COST,
  stats,
  tradesFor,
  type BetSeriesItem,
  type PowerSimResult,
  type SymbolData,
  type Trade,
} from './lab-v4-preview';

function makeBaseCandles(
  count: number,
  baseClose = 100,
  baseHigh = 102,
  baseLow = 98
): OHLCV[] {
  const candles: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    candles.push({
      timestamp: (i + 1) * 3_600_000,
      open: baseClose,
      high: baseHigh,
      low: baseLow,
      close: baseClose,
      volume: 1000,
      takerBuyVolume: 500,
    });
  }
  return candles;
}

describe('lab-v4-preview', () => {
  describe('c1Signals', () => {
    it('keeps a CHoCH with a same-sign break-bar delta, and drops one with an opposite-sign or null delta', () => {
      // Build 150 bars with SWING_LENGTH = 20
      // Bar 25: Swing High 1 at 150 (bars 5..45 below 150), confirmed at bar 45
      // Bar 50: Swing Low 1 at 40 (bars 30..70 above 40), confirmed at bar 70
      // Bar 75: Closes at 35 (< 40) -> breaks Low 1, BOS bear, trend becomes -1
      // Bar 85: Swing High 2 at 120 (bars 65..105 below 120), confirmed at bar 105
      // Bar 110: Closes at 130 (> 120) -> breaks High 2, trend was -1 so CHoCH bull!

      const createSetup = (breakTakerBuyVolume: number | null): OHLCV[] => {
        const bars = makeBaseCandles(150, 95, 100, 90);

        // High 1 at 25
        bars[25].high = 150;

        // Low 1 at 50
        bars[50].low = 40;

        // Break Low 1 at 75 (BOS bear)
        bars[75].close = 35;
        bars[75].low = 30;

        // High 2 at 85
        bars[85].high = 120;

        // Break High 2 at 110 (CHoCH bull)
        bars[110].close = 130;
        bars[110].high = 135;
        bars[110].volume = 1000;
        bars[110].takerBuyVolume = breakTakerBuyVolume ?? undefined;

        return bars;
      };

      // 1. Same-sign: bull CHoCH with delta > 0 (tbv 800 => delta = 2*800 - 1000 = 600 > 0)
      const barsSameSign = createSetup(800);
      const sigsSame = c1Signals(barsSameSign);
      expect(sigsSame).toHaveLength(1);
      expect(sigsSame[0]).toEqual({ index: 110, side: 1 });

      // 2. Opposite-sign: bull CHoCH with delta < 0 (tbv 200 => delta = 2*200 - 1000 = -600 < 0)
      const barsOpposite = createSetup(200);
      const sigsOpposite = c1Signals(barsOpposite);
      expect(sigsOpposite).toHaveLength(0);

      // 3. Null delta: bull CHoCH with null tbv => delta null
      const barsNull = createSetup(null);
      const sigsNull = c1Signals(barsNull);
      expect(sigsNull).toHaveLength(0);

      // 4. Zero delta: bull CHoCH with tbv 500 => delta = 0
      const barsZero = createSetup(500);
      const sigsZero = c1Signals(barsZero);
      expect(sigsZero).toHaveLength(0);
    });
  });

  describe('c2Signals', () => {
    it('keeps only regular divergences, with the right side', () => {
      // Pivots with SWING_LENGTH = 20:
      // High 1 at 25, price 150 (confirmed at 45)
      // High 2 at 60, price 180 (confirmed at 80): second.price > first.price
      // Delta in (25, 60] has tbv 200 => delta = -600 per bar => summedDelta < 0
      // High 2 vs High 1: second.price > first.price and summedDelta < 0 => regular bear divergence (side -1)

      // High 3 at 95, price 160 (confirmed at 115): second.price < first.price
      // Delta in (60, 95] has tbv 800 => delta = +600 per bar => summedDelta > 0
      // High 3 vs High 2: second.price < first.price and summedDelta > 0 => hidden bear divergence (kind === 'hidden')

      const bars = makeBaseCandles(150, 95, 100, 90);

      // High 1 at 25
      bars[25].high = 150;

      // High 2 at 60
      bars[60].high = 180;
      for (let i = 26; i <= 60; i++) {
        bars[i].volume = 1000;
        bars[i].takerBuyVolume = 200; // delta = -600
      }

      // High 3 at 95
      bars[95].high = 160;
      for (let i = 61; i <= 95; i++) {
        bars[i].volume = 1000;
        bars[i].takerBuyVolume = 800; // delta = +600
      }

      const sigs = c2Signals(bars);

      // Should keep ONLY the regular divergence (at confirmedIndex 80), not the hidden one (at 115)
      expect(sigs).toHaveLength(1);
      expect(sigs[0]).toEqual({ index: 80, side: -1 });

      // Lows regular bull test:
      // Low 1 at 25, price 80 (confirmed at 45)
      // Low 2 at 60, price 50 (confirmed at 80): second.price < first.price
      // Delta in (25, 60] has tbv 800 => delta = +600 => summedDelta > 0 => regular bull divergence (side +1)
      const bullBars = makeBaseCandles(150, 95, 100, 90);
      bullBars[25].low = 80;
      bullBars[60].low = 50;
      for (let i = 26; i <= 60; i++) {
        bullBars[i].volume = 1000;
        bullBars[i].takerBuyVolume = 800;
      }

      const bullSigs = c2Signals(bullBars);
      expect(bullSigs).toHaveLength(1);
      expect(bullSigs[0]).toEqual({ index: 80, side: 1 });
    });
  });

  describe('tradesFor', () => {
    it('entry at next bar open and exit 8 bars later, funding summed over (entry, exit], long pays funding and short receives it, cost subtracted, overlapping signal ignored', () => {
      // 30 bars
      const bars: OHLCV[] = [];
      for (let i = 0; i < 30; i++) {
        bars.push({
          timestamp: i * 3_600_000,
          open: 100 + i,
          high: 105 + i,
          low: 95 + i,
          close: 101 + i,
          volume: 1000,
          takerBuyVolume: 500,
        });
      }

      // Signal at bar 0:
      // Entry is bar 1 (open = bars[1].open = 101, timestamp = 3_600_000)
      // Exit is bar 9 (open = bars[9].open = 109, timestamp = 9 * 3_600_000 = 32_400_000)
      // Return r = 109 / 101 - 1
      const entryTime = bars[1].timestamp; // 3_600_000
      const exitTime = bars[9].timestamp; // 32_400_000

      // Settlements:
      // - exactly at entryTime: 3_600_000 (must be EXCLUDED)
      // - intermediate: 10_000_000 (INCLUDED)
      // - exactly at exitTime: 32_400_000 (must be INCLUDED)
      // - outside: 33_000_000 (EXCLUDED)
      const settlements = [
        { t: entryTime - 1000, rate: 0.010 },
        { t: entryTime, rate: 0.005 }, // excluded
        { t: 10_000_000, rate: 0.002 }, // included
        { t: exitTime, rate: 0.003 }, // included
        { t: exitTime + 1000, rate: 0.010 }, // excluded
      ];

      // Test long trade (side = 1)
      const longTrades = tradesFor(bars, settlements, [{ index: 0, side: 1 }]);
      expect(longTrades).toHaveLength(1);
      const longTrade = longTrades[0];

      expect(longTrade.entryTime).toBe(entryTime);
      expect(longTrade.exitTime).toBe(exitTime);
      expect(longTrade.side).toBe(1);

      const expectedR = 109 / 101 - 1;
      expect(longTrade.r).toBeCloseTo(expectedR, 10);

      // Funding F = 0.002 + 0.003 = 0.005
      expect(longTrade.funding).toBeCloseTo(0.005, 10);

      // Long net = 1 * r - 1 * funding - ROUND_TRIP_COST
      const expectedLongNet = expectedR - 0.005 - ROUND_TRIP_COST;
      expect(longTrade.net).toBeCloseTo(expectedLongNet, 10);

      // Test short trade (side = -1)
      const shortTrades = tradesFor(bars, settlements, [{ index: 0, side: -1 }]);
      expect(shortTrades).toHaveLength(1);
      const shortTrade = shortTrades[0];
      // Short net = -1 * r - (-1) * funding - ROUND_TRIP_COST = -r + funding - ROUND_TRIP_COST
      const expectedShortNet = -expectedR + 0.005 - ROUND_TRIP_COST;
      expect(shortTrade.net).toBeCloseTo(expectedShortNet, 10);

      // Test overlap rule:
      // Signal at 0: enters bar 1, exits bar 9
      // Signal at 4: entry bar is 5 < 9 -> ignored
      // Signal at 8: entry bar is 9 (not < 9) -> accepted (enters bar 9, exits bar 17)
      const signals = [
        { index: 0, side: 1 },
        { index: 4, side: 1 },
        { index: 8, side: -1 },
      ];
      const multiTrades = tradesFor(bars, settlements, signals);
      expect(multiTrades).toHaveLength(2);
      expect(multiTrades[0].entryTime).toBe(bars[1].timestamp);
      expect(multiTrades[0].exitTime).toBe(bars[9].timestamp);
      expect(multiTrades[1].entryTime).toBe(bars[9].timestamp);
      expect(multiTrades[1].exitTime).toBe(bars[17].timestamp);
    });

    it('skips a trade when the next bar is 2 hours later, and countGapSkips returns 1', () => {
      // Signal at bar 0 (t = 0)
      // Bar 1 is 2 hours later (t = 2 * HOUR_MS)
      // Subsequent bars contiguous from bar 1
      const bars: OHLCV[] = [
        {
          timestamp: 0,
          open: 100,
          high: 105,
          low: 95,
          close: 101,
          volume: 1000,
          takerBuyVolume: 500,
        },
      ];
      for (let i = 1; i <= 15; i++) {
        bars.push({
          timestamp: (i + 1) * HOUR_MS,
          open: 100 + i,
          high: 105 + i,
          low: 95 + i,
          close: 101 + i,
          volume: 1000,
          takerBuyVolume: 500,
        });
      }

      const signals = [{ index: 0, side: 1 }];
      const trades = tradesFor(bars, [], signals);
      expect(trades).toHaveLength(0);
      expect(countGapSkips(bars, signals)).toBe(1);
    });

    it('skips a trade when there is a gap inside the hold', () => {
      // Signal at bar 0 (t = 0)
      // Bar 1 at t = HOUR_MS (valid entry spacing)
      // Bar 2 at t = 3 * HOUR_MS (gap inside hold)
      // Subsequent bars contiguous from bar 2
      const bars: OHLCV[] = [
        {
          timestamp: 0,
          open: 100,
          high: 105,
          low: 95,
          close: 101,
          volume: 1000,
          takerBuyVolume: 500,
        },
        {
          timestamp: HOUR_MS,
          open: 101,
          high: 106,
          low: 96,
          close: 102,
          volume: 1000,
          takerBuyVolume: 500,
        },
      ];
      for (let i = 2; i <= 15; i++) {
        bars.push({
          timestamp: (i + 1) * HOUR_MS,
          open: 100 + i,
          high: 105 + i,
          low: 95 + i,
          close: 101 + i,
          volume: 1000,
          takerBuyVolume: 500,
        });
      }

      const signals = [{ index: 0, side: 1 }];
      const trades = tradesFor(bars, [], signals);
      expect(trades).toHaveLength(0);
      expect(countGapSkips(bars, signals)).toBe(1);
    });

    it('behaves as expected on contiguous bars with zero gap skips', () => {
      const bars: OHLCV[] = [];
      for (let i = 0; i < 20; i++) {
        bars.push({
          timestamp: i * HOUR_MS,
          open: 100 + i,
          high: 105 + i,
          low: 95 + i,
          close: 100 + i,
          volume: 1000,
          takerBuyVolume: 500,
        });
      }

      const signals = [{ index: 0, side: 1 }];
      const trades = tradesFor(bars, [], signals);
      expect(trades).toHaveLength(1);
      expect(trades[0].entryTime).toBe(HOUR_MS);
      expect(trades[0].exitTime).toBe(9 * HOUR_MS);
      expect(countGapSkips(bars, signals)).toBe(0);
    });

    it('applies the overlap rule to countGapSkips so overlapping signals during a trade are ignored', () => {
      const bars: OHLCV[] = [];
      for (let i = 0; i < 30; i++) {
        bars.push({
          timestamp: i * HOUR_MS,
          open: 100 + i,
          high: 105 + i,
          low: 95 + i,
          close: 100 + i,
          volume: 1000,
          takerBuyVolume: 500,
        });
      }

      // Signal 0: enters at bar 1, exits at bar 9 (valid trade)
      // Signal 4: overlaps with trade 0 (entry bar 5 < exit bar 9) -> ignored by overlap, not counted as gap skip
      // Signal 10: enters at bar 11, exits at bar 19 (valid trade)
      const signals = [
        { index: 0, side: 1 },
        { index: 4, side: 1 },
        { index: 10, side: 1 },
      ];
      expect(tradesFor(bars, [], signals)).toHaveLength(2);
      expect(countGapSkips(bars, signals)).toBe(0);
    });
  });

  describe('constants', () => {
    it('exports constants with expected values', () => {
      expect(HOUR_MS).toBe(3_600_000);
      expect(ROUND_TRIP_COST).toBe(0.0014);
      expect(C7_FUNDING_BASELINE).toBe(0.0001);
      expect(C7_OI_LOOKBACK_MS).toBe(24 * HOUR_MS);
      expect(C7_OI_LAG_MS).toBe(5 * 60_000);
      expect(C7_OI_MAX_STALENESS_MS).toBe(15 * 60_000);
      expect(DECISION_FLOOR).toBe(0.2);
    });
  });

  describe('betSeries', () => {
    it('sums two symbols entering at the same time into one R_t', () => {
      const tradeA1: Trade = {
        entryTime: 10_000,
        exitTime: 20_000,
        side: 1,
        r: 0.02,
        funding: 0,
        net: 0.015,
      };
      const tradeA2: Trade = {
        entryTime: 30_000,
        exitTime: 40_000,
        side: -1,
        r: -0.01,
        funding: 0,
        net: 0.008,
      };
      const tradeB1: Trade = {
        entryTime: 10_000,
        exitTime: 20_000,
        side: 1,
        r: 0.03,
        funding: 0,
        net: 0.025,
      };

      const series = betSeries({
        BTCUSDT: [tradeA1, tradeA2],
        ETHUSDT: [tradeB1],
      });

      expect(series).toHaveLength(2);
      expect(series[0]).toEqual({
        time: 10_000,
        R: 0.015 + 0.025,
      });
      expect(series[1]).toEqual({
        time: 30_000,
        R: 0.008,
      });
    });
  });

  describe('stats', () => {
    it('gives the scale as 4 x SD rounded up to 2 significant figures', () => {
      // Construct a return series with known sample SD
      // Values: [0.01, -0.01, 0.015, -0.015]
      // Mean = 0
      // Sum of squares = 0.0001 + 0.0001 + 0.000225 + 0.000225 = 0.00065
      // Sample variance = 0.00065 / 3 = 0.0002166666...
      // SD = Math.sqrt(0.0002166666...) ~ 0.0147196
      // 4 x SD ~ 0.058878
      // Round up to 2 sig figs -> 0.059
      const series: BetSeriesItem[] = [
        { time: 10_000, R: 0.01 },
        { time: 20_000, R: -0.01 },
        { time: 30_000, R: 0.015 },
        { time: 40_000, R: -0.015 },
      ];
      const trades: Trade[] = [
        { entryTime: 10_000, exitTime: 20_000, side: 1, r: 0.01, funding: 0, net: 0.008 },
        { entryTime: 20_000, exitTime: 30_000, side: -1, r: 0.01, funding: 0, net: -0.011 },
        { entryTime: 30_000, exitTime: 40_000, side: 1, r: 0.015, funding: 0, net: 0.013 },
        { entryTime: 40_000, exitTime: 50_000, side: -1, r: 0.015, funding: 0, net: -0.016 },
      ];

      const res = stats(series, trades);
      expect(res.scale).toBeCloseTo(0.059, 8);
      expect(res.trades).toBe(4);
      expect(res.betBars).toBe(4);
      expect(res.shareBelowMinusC).toBe(0);
      expect(res.shareBelowMinus2C).toBe(0);
    });
  });

  describe('nullSim and powerSim', () => {
    it('nullSim and powerSim are deterministic with the seed (same output twice)', () => {
      const series: BetSeriesItem[] = [
        { time: 10_000, R: 0.01 },
        { time: 20_000, R: -0.005 },
        { time: 30_000, R: 0.02 },
        { time: 40_000, R: -0.01 },
        { time: 50_000, R: 0.015 },
      ];
      const trades: Trade[] = [
        { entryTime: 10_000, exitTime: 18_000, side: 1, r: 0.015, funding: 0.001, net: 0.01 },
        { entryTime: 20_000, exitTime: 28_000, side: -1, r: 0.005, funding: 0.001, net: -0.005 },
        { entryTime: 30_000, exitTime: 38_000, side: 1, r: 0.025, funding: 0.001, net: 0.02 },
        { entryTime: 40_000, exitTime: 48_000, side: -1, r: 0.010, funding: 0.001, net: -0.01 },
        { entryTime: 50_000, exitTime: 58_000, side: 1, r: 0.020, funding: 0.001, net: 0.015 },
      ];
      const scale = 0.06;

      const power1 = powerSim(series, scale, 100, { seed: 42, runsCount: 40, trades });
      const power2 = powerSim(series, scale, 100, { seed: 42, runsCount: 40, trades });
      expect(power1).toEqual(power2);

      const null1 = nullSim(trades, scale, { seed: 42, runsCount: 40 });
      const null2 = nullSim(trades, scale, { seed: 42, runsCount: 40 });
      expect(null1).toEqual(null2);
    });
  });

  describe('c7Signals', () => {
    const BASE = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS;
    const bars: OHLCV[] = [];
    for (let i = 0; i < 40; i++) {
      bars.push({
        timestamp: BASE + i * HOUR_MS,
        open: 100,
        high: 105,
        low: 95,
        close: 100,
        volume: 1000,
        takerBuyVolume: 500,
      });
    }

    const T = BASE + 30 * HOUR_MS;
    const barIndexTMinus1h = 29;

    function makeMetrics(t: number, openInterest: number | null): MetricsRow {
      return {
        t,
        openInterest,
        openInterestValue: null,
        topTraderAccountRatio: null,
        topTraderPositionRatio: null,
        globalAccountRatio: null,
        takerLongShortRatio: null,
        depthImbalance1: null,
        depthImbalance2: null,
        depthImbalance5: null,
        depthNotional1: null,
        depthNotional5: null,
      };
    }

    const tMinus5m = T - 5 * 60_000;
    const tMinus24h5m = T - 24 * HOUR_MS - 5 * 60_000;

    it('emits side -1 for rate 0.0003 at T with rising OI (110 vs 100)', () => {
      const settlements = [{ t: T, rate: 0.0003 }];
      const metrics = [
        makeMetrics(tMinus24h5m, 100),
        makeMetrics(tMinus5m, 110),
      ];
      const sigs = c7Signals(bars, settlements, metrics);
      expect(sigs).toEqual([{ index: barIndexTMinus1h, side: -1 }]);
    });

    it('emits side 1 for rate -0.0001 with the same rising OI', () => {
      const settlements = [{ t: T, rate: -0.0001 }];
      const metrics = [
        makeMetrics(tMinus24h5m, 100),
        makeMetrics(tMinus5m, 110),
      ];
      const sigs = c7Signals(bars, settlements, metrics);
      expect(sigs).toEqual([{ index: barIndexTMinus1h, side: 1 }]);
    });

    it('emits nothing for rate exactly 0.0001 or rate exactly 0', () => {
      const metrics = [
        makeMetrics(tMinus24h5m, 100),
        makeMetrics(tMinus5m, 110),
      ];
      expect(c7Signals(bars, [{ t: T, rate: 0.0001 }], metrics)).toEqual([]);
      expect(c7Signals(bars, [{ t: T, rate: 0 }], metrics)).toEqual([]);
    });

    it('emits nothing for falling OI (90 against 100)', () => {
      const settlements = [{ t: T, rate: 0.0003 }];
      const metrics = [
        makeMetrics(tMinus24h5m, 100),
        makeMetrics(tMinus5m, 90),
      ];
      expect(c7Signals(bars, settlements, metrics)).toEqual([]);
    });

    it('emits nothing when the last row before T - 5 min is older than 15 min', () => {
      const settlements = [{ t: T, rate: 0.0003 }];
      const metrics = [
        makeMetrics(tMinus24h5m, 100),
        makeMetrics(tMinus5m - 16 * 60_000, 110),
      ];
      expect(c7Signals(bars, settlements, metrics)).toEqual([]);
    });

    it('treats settlement stamped T + 7 ms as T', () => {
      const settlements = [{ t: T + 7, rate: 0.0003 }];
      const metrics = [
        makeMetrics(tMinus24h5m, 100),
        makeMetrics(tMinus5m, 110),
      ];
      const sigs = c7Signals(bars, settlements, metrics);
      expect(sigs).toEqual([{ index: barIndexTMinus1h, side: -1 }]);
    });

    it('does not look ahead when a row at T - 2 min exists', () => {
      const settlements = [{ t: T, rate: 0.0003 }];
      const metrics = [
        makeMetrics(tMinus24h5m, 100),
        makeMetrics(tMinus5m, 110),
        makeMetrics(T - 2 * 60_000, 1),
      ];
      const sigs = c7Signals(bars, settlements, metrics);
      expect(sigs).toEqual([{ index: barIndexTMinus1h, side: -1 }]);
    });

    it('emits nothing when there is no bar at T - 1h', () => {
      const settlements = [{ t: T, rate: 0.0003 }];
      const metrics = [
        makeMetrics(tMinus24h5m, 100),
        makeMetrics(tMinus5m, 110),
      ];
      const missingBarBars = bars.filter((b) => b.timestamp !== T - HOUR_MS);
      expect(c7Signals(missingBarBars, settlements, metrics)).toEqual([]);
    });
  });

  describe('powerSim threshold and targets', () => {
    it('crosses at least as often and no later with threshold 400 than with default 800', () => {
      const series = [0.015, 0.01, 0.02, 0.012, 0.018];
      const scale = 0.05;
      const betBarsPerYear = 100;

      const res400 = powerSim(series, scale, betBarsPerYear, { seed: 42, runsCount: 50, threshold: 400 });
      const res800 = powerSim(series, scale, betBarsPerYear, { seed: 42, runsCount: 50, threshold: 800 });
      const resDefault = powerSim(series, scale, betBarsPerYear, { seed: 42, runsCount: 50 });

      expect(resDefault.measured).toEqual(res800.measured);
      expect(res400.measured.iid.share).toBeGreaterThanOrEqual(res800.measured.iid.share);
      expect(res400.measured.block.share).toBeGreaterThanOrEqual(res800.measured.block.share);

      if (res400.measured.iid.medianBar !== null && res800.measured.iid.medianBar !== null) {
        expect(res400.measured.iid.medianBar).toBeLessThanOrEqual(res800.measured.iid.medianBar);
      }
      if (res400.measured.block.medianBar !== null && res800.measured.block.medianBar !== null) {
        expect(res400.measured.block.medianBar).toBeLessThanOrEqual(res800.measured.block.medianBar);
      }
    });

    it('gives halfMean shares of 0 for non-positive mean', () => {
      const series = [-0.01, -0.005, 0.002];
      const res = powerSim(series, 0.05, 100, { seed: 42, runsCount: 30 });
      expect(res.halfMean.iid.share).toBe(0);
      expect(res.halfMean.iid.medianBar).toBeNull();
      expect(res.halfMean.block.share).toBe(0);
      expect(res.halfMean.block.medianBar).toBeNull();
    });

    it('sharpe2 is present and its shares are between 0 and 1', () => {
      const series = [0.01, 0.02, -0.005, 0.015];
      const res = powerSim(series, 0.05, 100, { seed: 42, runsCount: 30 });
      expect(res.sharpe2).toBeDefined();
      expect(res.sharpe2.iid.share).toBeGreaterThanOrEqual(0);
      expect(res.sharpe2.iid.share).toBeLessThanOrEqual(1);
      expect(res.sharpe2.block.share).toBeGreaterThanOrEqual(0);
      expect(res.sharpe2.block.share).toBeLessThanOrEqual(1);
    });

    it('halfMean equals the measured case of the series shifted to half its mean', () => {
      const base = Array.from({ length: 400 }, (_, i) => 0.002 + 0.01 * Math.sin(i));
      const mean = base.reduce((a, v) => a + v, 0) / base.length;
      const shifted = base.map((v) => v - 0.5 * mean);
      const opts = { seed: 7, runsCount: 50 };
      expect(powerSim(base, 0.05, 300, opts).halfMean).toEqual(
        powerSim(shifted, 0.05, 300, opts).measured
      );
    });

    it('sharpe2 equals the measured case of the series shifted to an annual Sharpe of 2', () => {
      const base = Array.from({ length: 400 }, (_, i) => 0.002 + 0.01 * Math.sin(i));
      const mean = base.reduce((a, v) => a + v, 0) / base.length;
      const sd = Math.sqrt(base.reduce((a, v) => a + (v - mean) ** 2, 0) / (base.length - 1));
      const target = (2 * sd) / Math.sqrt(300);
      const atSharpe2 = base.map((v) => v + (target - mean));
      const opts = { seed: 7, runsCount: 50 };
      expect(powerSim(base, 0.05, 300, opts).sharpe2).toEqual(
        powerSim(atSharpe2, 0.05, 300, opts).measured
      );
    });
  });

  describe('decideSlots', () => {
    it('gives two slots at 800 when two candidates each reach 0.20 at threshold 800, highest first', () => {
      const candidates = [
        { id: 'C1', meanR: 0.005, tradeTStat: 2.0, figure400: 0.35, figure800: 0.25 },
        { id: 'C2', meanR: 0.006, tradeTStat: 2.5, figure400: 0.40, figure800: 0.30 },
      ];
      expect(decideSlots(candidates)).toEqual({
        slots: [
          { id: 'C2', threshold: 800 },
          { id: 'C1', threshold: 800 },
        ],
        reason: 'two slots at 800',
      });
    });

    it('gives one slot at 400 for highest figure400 when only one candidate reaches 0.20 at 800', () => {
      const candidates = [
        { id: 'C1', meanR: 0.005, tradeTStat: 2.0, figure400: 0.35, figure800: 0.25 },
        { id: 'C2', meanR: 0.006, tradeTStat: 2.5, figure400: 0.40, figure800: 0.15 },
      ];
      expect(decideSlots(candidates)).toEqual({
        slots: [{ id: 'C2', threshold: 400 }],
        reason: 'one slot at 400',
      });
    });

    it('never chooses a candidate with meanR <= 0', () => {
      const candidates = [
        { id: 'C1', meanR: -0.001, tradeTStat: -0.5, figure400: 0.9, figure800: 0.9 },
        { id: 'C2', meanR: 0.005, tradeTStat: 1.5, figure400: 0.25, figure800: 0.1 },
      ];
      expect(decideSlots(candidates)).toEqual({
        slots: [{ id: 'C2', threshold: 400 }],
        reason: 'one slot at 400',
      });
    });

    it('rejects a candidate whose meanR is exactly 0', () => {
      const candidates = [
        { id: 'C1', meanR: 0, tradeTStat: 3, figure400: 0.9, figure800: 0.9 },
      ];
      expect(decideSlots(candidates)).toEqual({
        slots: [],
        reason: 'nothing registered',
      });
    });

    it('returns no slots when all figures are below 0.2', () => {
      const candidates = [
        { id: 'C1', meanR: 0.005, tradeTStat: 1.0, figure400: 0.18, figure800: 0.15 },
        { id: 'C2', meanR: 0.006, tradeTStat: 1.2, figure400: 0.19, figure800: 0.10 },
      ];
      expect(decideSlots(candidates)).toEqual({
        slots: [],
        reason: 'nothing registered',
      });
    });

    it('breaks ties on figure400 by higher tradeTStat', () => {
      const candidates = [
        { id: 'C1', meanR: 0.005, tradeTStat: 1.5, figure400: 0.30, figure800: 0.10 },
        { id: 'C2', meanR: 0.005, tradeTStat: 2.8, figure400: 0.30, figure800: 0.10 },
      ];
      expect(decideSlots(candidates)).toEqual({
        slots: [{ id: 'C2', threshold: 400 }],
        reason: 'one slot at 400',
      });
    });
  });

  describe('previewCandidates window', () => {
    it('never produces trades after toMs and produces identical results with or without rows after toMs', () => {
      const fromMs = Math.floor(1_700_000_000_000 / HOUR_MS) * HOUR_MS;
      const toMs = fromMs + 40 * HOUR_MS;

      const makeMetrics = (t: number, openInterest: number | null): MetricsRow => ({
        t,
        openInterest,
        openInterestValue: null,
        topTraderAccountRatio: null,
        topTraderPositionRatio: null,
        globalAccountRatio: null,
        takerLongShortRatio: null,
        depthImbalance1: null,
        depthImbalance2: null,
        depthImbalance5: null,
        depthNotional1: null,
        depthNotional5: null,
      });

      const buildSymbolData = (includeAfter: boolean): SymbolData => {
        const bars: OHLCV[] = [];
        for (let i = 0; i <= 40; i++) {
          bars.push({
            timestamp: fromMs + i * HOUR_MS,
            open: 100,
            high: 105,
            low: 95,
            close: 100,
            volume: 1000,
            takerBuyVolume: 500,
          });
        }
        const settlements = [{ t: fromMs + 26 * HOUR_MS, rate: 0.0003 }];
        const metrics = [
          makeMetrics(fromMs + 2 * HOUR_MS - 5 * 60_000, 100),
          makeMetrics(fromMs + 26 * HOUR_MS - 5 * 60_000, 110),
        ];

        if (includeAfter) {
          bars.push({
            timestamp: toMs + HOUR_MS,
            open: 1_000_000,
            high: 1_000_005,
            low: 999_995,
            close: 1_000_000,
            volume: 1000,
            takerBuyVolume: 500,
          });
          settlements.push({ t: toMs + HOUR_MS, rate: 0.5 });
          metrics.push(makeMetrics(toMs + HOUR_MS, 999_999));
        }

        return { bars, settlements, metrics };
      };

      const dataWithAfter: Record<string, SymbolData> = {
        BTCUSDT: buildSymbolData(true),
        ETHUSDT: buildSymbolData(true),
      };

      const dataWithoutAfter: Record<string, SymbolData> = {
        BTCUSDT: buildSymbolData(false),
        ETHUSDT: buildSymbolData(false),
      };

      const resWith = previewCandidates(dataWithAfter, fromMs, toMs, CANDIDATES, {
        runsCount: 20,
        seed: 1,
      });
      const resWithout = previewCandidates(dataWithoutAfter, fromMs, toMs, CANDIDATES, {
        runsCount: 20,
        seed: 1,
      });

      for (const cand of Object.values(resWith.candidates)) {
        for (const tr of cand.trades) {
          expect(tr.exitTime).toBeLessThanOrEqual(toMs);
        }
      }
      expect(resWith.candidates.C7.trades.length).toBeGreaterThan(0);
      expect(resWith.candidates).toEqual(resWithout.candidates);
    });
  });

  describe('figureOf', () => {
    it('returns the minimum of halfMean iid and block share', () => {
      const dummyCase = {
        iid: { share: 0, medianBar: null },
        block: { share: 0, medianBar: null },
      };
      const power: PowerSimResult = {
        measured: dummyCase,
        plus05bps: dummyCase,
        plus10bps: dummyCase,
        plus20bps: dummyCase,
        halfMean: {
          iid: { share: 0.35, medianBar: 50 },
          block: { share: 0.28, medianBar: 60 },
        },
        sharpe2: dummyCase,
      };
      expect(figureOf(power)).toBe(0.28);
    });
  });
});
