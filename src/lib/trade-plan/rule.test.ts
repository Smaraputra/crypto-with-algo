// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { OHLCV } from '@/types/market';
import { BINANCE_FUTURES_TAKER_FEE, studyCostConfig } from '@/lib/backtest/cost-model';
import { deriveVolatilityStops } from '@/lib/optimization/walk-forward';
import { STRATEGY_EXIT_LEVEL, TIER_BUY_CUTOFF } from '@/lib/signals/calibration';
import {
  RISK_PER_TRADE,
  STOP_WINDOW_BARS,
  TRADE_PLAN_STRATEGY,
  stopsFor,
  tradePlanConfig,
} from './rule';

/** Flat bars at 100 whose true range is `rangePercent` of the close. */
function flatBars(count: number, rangePercent: number, start = 0): OHLCV[] {
  const half = rangePercent / 2;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: (start + i) * 3_600_000,
    open: 100,
    high: 100 + half,
    low: 100 - half,
    close: 100,
    volume: 1,
  }));
}

describe('TRADE_PLAN_STRATEGY', () => {
  it('is the score-threshold rule the research control family measured', () => {
    expect(TRADE_PLAN_STRATEGY.name).toBe('score-threshold');
  });
});

describe('tradePlanConfig', () => {
  const stops = { stopLossPercent: 0.02, takeProfitPercent: 0.04 };

  it('reproduces the research walk-forward configuration', () => {
    const config = tradePlanConfig('day_trading', '1h', stops, 1000);
    expect(config).toMatchObject({
      entryThreshold: TIER_BUY_CUTOFF,
      exitThreshold: STRATEGY_EXIT_LEVEL,
      shortEntryThreshold: -TIER_BUY_CUTOFF,
      shortExitThreshold: -STRATEGY_EXIT_LEVEL,
      allowShorts: true,
      positionSizing: { method: 'risk_based', riskPerTrade: RISK_PER_TRADE },
      stopLossPercent: 0.02,
      takeProfitPercent: 0.04,
      fundingEnabled: true,
      startEquity: 1000,
      ...studyCostConfig('1h'),
    });
  });

  it('uses the same levels for every style', () => {
    for (const style of ['scalping', 'day_trading', 'swing_trading', 'position_trading'] as const) {
      const config = tradePlanConfig(style, '1d', stops);
      expect(config.entryThreshold).toBe(TIER_BUY_CUTOFF);
      expect(config.exitThreshold).toBe(STRATEGY_EXIT_LEVEL);
    }
  });

  it('throws for an interval with no study slippage budget', () => {
    expect(() => tradePlanConfig('day_trading', '30m', stops)).toThrow('No slippage budget');
  });
});

describe('stopsFor', () => {
  it('equals deriveVolatilityStops at the taker fee over the same bars', () => {
    const bars = flatBars(50, 1.5);
    expect(stopsFor(bars)).toEqual(deriveVolatilityStops(bars, BINANCE_FUTURES_TAKER_FEE));
  });

  it(`measures only the trailing ${STOP_WINDOW_BARS} true ranges`, () => {
    // 600 wide bars (10% range) followed by 1001 narrow ones (1% range): the
    // window must see only the narrow ones, so the stop is 2 x 1% = 2%.
    const bars = [...flatBars(600, 10), ...flatBars(STOP_WINDOW_BARS + 1, 1, 600)];
    const stops = stopsFor(bars);
    expect(stops.medianTrueRangePercent).toBeCloseTo(0.01, 10);
    expect(stops.stopLossPercent).toBeCloseTo(0.02, 10);
    expect(stops.takeProfitPercent).toBeCloseTo(0.04, 10);
  });

  it('floors the stop at five taker round trips when bars barely move', () => {
    const stops = stopsFor(flatBars(100, 0.01));
    expect(stops.stopLossPercent).toBeCloseTo(2 * BINANCE_FUTURES_TAKER_FEE * 5, 12);
  });
});
