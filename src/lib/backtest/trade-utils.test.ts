// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  checkStopTakeProfit,
  closeTrade,
  computeEquityAfterTrade,
  computePositionSize,
  type OpenPosition,
} from './trade-utils';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { BacktestConfig, BacktestTrade } from './types';
import type { OHLCV } from '@/types/market';

const makePosition = (overrides: Partial<OpenPosition> = {}): OpenPosition => ({
  entryBar: 10,
  entryTime: 1700000000000,
  entryPrice: 100,
  side: 'long',
  quantity: 10,
  entryScore: 50,
  entryTier: 'buy',
  ...overrides,
});

const makeCandle = (overrides: Partial<OHLCV> = {}): OHLCV => ({
  timestamp: 1700000360000,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1000,
  ...overrides,
});

const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG };

describe('checkStopTakeProfit', () => {
  it('triggers long stop loss when low crosses SL price', () => {
    const position = makePosition();
    const candle = makeCandle({ low: 94.9 }); // SL at 95 (5%)

    const { exitReason, exitPrice } = checkStopTakeProfit(position, candle, config);
    expect(exitReason).toBe('stop_loss');
    expect(exitPrice).toBeCloseTo(95);
  });

  it('triggers long take profit when high crosses TP price', () => {
    const position = makePosition();
    const candle = makeCandle({ high: 110.1 }); // TP at 110 (10%)

    const { exitReason, exitPrice } = checkStopTakeProfit(position, candle, config);
    expect(exitReason).toBe('take_profit');
    expect(exitPrice).toBeCloseTo(110);
  });

  it('stop loss wins when both SL and TP hit in the same bar', () => {
    const position = makePosition();
    const candle = makeCandle({ low: 94, high: 111 });

    const { exitReason } = checkStopTakeProfit(position, candle, config);
    expect(exitReason).toBe('stop_loss');
  });

  it('handles short positions with inverted levels', () => {
    const position = makePosition({ side: 'short' });
    const slCandle = makeCandle({ high: 105.1 }); // short SL at 105
    const tpCandle = makeCandle({ low: 89.9 }); // short TP at 90

    expect(checkStopTakeProfit(position, slCandle, config).exitReason).toBe('stop_loss');
    expect(checkStopTakeProfit(position, tpCandle, config).exitReason).toBe('take_profit');
  });

  it('returns null when neither level is hit', () => {
    const position = makePosition();
    const candle = makeCandle();

    expect(checkStopTakeProfit(position, candle, config).exitReason).toBeNull();
  });
});

describe('closeTrade', () => {
  it('computes pnl net of fees on both legs', () => {
    const position = makePosition(); // 10 units at 100
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'take_profit', 0, trades, config);

    const trade = trades[0];
    // Gross: (110-100)*10 = 100; fees: 0.1% of 1000 + 0.1% of 1100 = 2.1
    expect(trade.pnl).toBeCloseTo(97.9);
    expect(trade.fees).toBeCloseTo(2.1);
  });

  it('computes pnlPercent net of fees relative to entry notional', () => {
    const position = makePosition();
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'take_profit', 0, trades, config);

    // 97.9 / 1000 * 100 = 9.79, NOT the gross price change of 10%
    expect(trades[0].pnlPercent).toBeCloseTo(9.79);
  });

  it('computes short pnl and pnlPercent consistently', () => {
    const position = makePosition({ side: 'short' });
    const trades: BacktestTrade[] = [];

    closeTrade(position, 90, 20, 1700003600000, 'take_profit', 0, trades, config);

    // Gross: (100-90)*10 = 100; fees: 0.1% of 1000 + 0.1% of 900 = 1.9
    expect(trades[0].pnl).toBeCloseTo(98.1);
    expect(trades[0].pnlPercent).toBeCloseTo(9.81);
  });

  it('records trade metadata', () => {
    const position = makePosition();
    const trades: BacktestTrade[] = [];

    closeTrade(position, 105, 25, 1700003600000, 'signal', -15, trades, config);

    const trade = trades[0];
    expect(trade.entryBar).toBe(10);
    expect(trade.exitBar).toBe(25);
    expect(trade.holdTimeBars).toBe(15);
    expect(trade.exitReason).toBe('signal');
    expect(trade.exitScore).toBe(-15);
    expect(trade.entryTier).toBe('buy');
  });
});

describe('closeTrade cost model', () => {
  it('with new config fields absent, fees and pnl match a hand computation with feePercent', () => {
    const position = makePosition(); // 10 units at 100
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'stop_loss', 0, trades, config);

    // Gross: (110-100)*10 = 100; fees: 0.1% of 1000 + 0.1% of 1100 = 2.1
    const trade = trades[0];
    expect(trade.pnl).toBeCloseTo(97.9);
    expect(trade.fees).toBeCloseTo(2.1);
    expect(trade.exitPrice).toBe(110);
    expect(trade.slippageCost).toBe(0);
    expect(trade.entryFillKind).toBe('taker');
    expect(trade.exitFillKind).toBe('taker');
  });

  it('takerFeePercent changes stop_loss, signal, and end_of_data fees but not take_profit', () => {
    const takerConfig: BacktestConfig = { ...config, takerFeePercent: 0.0005 };

    for (const exitReason of ['stop_loss', 'signal', 'end_of_data'] as const) {
      const position = makePosition();
      const trades: BacktestTrade[] = [];
      closeTrade(position, 110, 20, 1700003600000, exitReason, 0, trades, takerConfig);
      // entry fee: 1000 * 0.0005 = 0.5; exit fee: 1100 * 0.0005 = 0.55; total 1.05
      expect(trades[0].fees).toBeCloseTo(1.05);
    }

    const position = makePosition();
    const trades: BacktestTrade[] = [];
    closeTrade(position, 110, 20, 1700003600000, 'take_profit', 0, trades, takerConfig);
    // take_profit is a maker fill; takerFeePercent must not apply to either leg here
    // since entryFillKind defaults to taker but exit is maker, and makerFeePercent is absent
    // so exit falls back to feePercent (0.001), not takerFeePercent.
    expect(trades[0].fees).toBeCloseTo(0.5 + 1.1); // entry taker 0.0005*1000=0.5, exit fallback feePercent 0.001*1100=1.1
  });

  it('makerFeePercent applies to take_profit exits', () => {
    const makerConfig: BacktestConfig = { ...config, makerFeePercent: 0.0002 };
    const position = makePosition();
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'take_profit', 0, trades, makerConfig);

    // entry fee falls back to feePercent (0.001) since entry is taker by default: 1000*0.001=1
    // exit fee uses makerFeePercent: 1100*0.0002=0.22
    expect(trades[0].fees).toBeCloseTo(1 + 0.22);
    expect(trades[0].exitFillKind).toBe('maker');
  });

  it('slippageBps moves a long stop_loss exit lower', () => {
    const slipConfig: BacktestConfig = { ...config, slippageBps: 10 };
    const position = makePosition({ side: 'long' });
    const trades: BacktestTrade[] = [];

    closeTrade(position, 95, 20, 1700003600000, 'stop_loss', 0, trades, slipConfig);

    // sell fill slips down: 95 * (1 - 10/10000) = 94.905
    expect(trades[0].exitPrice).toBeCloseTo(94.905);
    expect(trades[0].slippageCost).toBeCloseTo(Math.abs(94.905 - 95) * 10);
  });

  it('slippageBps moves a short stop_loss exit higher', () => {
    const slipConfig: BacktestConfig = { ...config, slippageBps: 10 };
    const position = makePosition({ side: 'short' });
    const trades: BacktestTrade[] = [];

    closeTrade(position, 105, 20, 1700003600000, 'stop_loss', 0, trades, slipConfig);

    // buy fill slips up: 105 * (1 + 10/10000) = 105.105
    expect(trades[0].exitPrice).toBeCloseTo(105.105);
    expect(trades[0].slippageCost).toBeCloseTo(Math.abs(105.105 - 105) * 10);
  });

  it('slippageBps leaves take_profit exits untouched', () => {
    const slipConfig: BacktestConfig = { ...config, slippageBps: 10 };
    const position = makePosition();
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'take_profit', 0, trades, slipConfig);

    expect(trades[0].exitPrice).toBe(110);
    expect(trades[0].slippageCost).toBe(0);
  });

  it('entryFillKind maker charges the maker rate on entry', () => {
    const feeConfig: BacktestConfig = { ...config, makerFeePercent: 0.0002, takerFeePercent: 0.0005 };
    const position = makePosition({ entryFillKind: 'maker' });
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'stop_loss', 0, trades, feeConfig);

    // entry fee uses maker: 1000*0.0002=0.2; exit fee uses taker (stop_loss): 1100*0.0005=0.55
    expect(trades[0].fees).toBeCloseTo(0.2 + 0.55);
    expect(trades[0].entryFillKind).toBe('maker');
  });
});

describe('computeEquityAfterTrade', () => {
  it('adds trade pnl to equity', () => {
    const trade = { pnl: 250 } as BacktestTrade;
    expect(computeEquityAfterTrade(10000, trade)).toBe(10250);
  });
});

describe('computePositionSize', () => {
  it('uses fixed percent by default', () => {
    const quantity = computePositionSize(10000, 100, 'long', config, []);
    // 10% of 10000 = 1000 notional at price 100 = 10 units
    expect(quantity).toBeCloseTo(10);
  });

  it('uses risk-based sizing when configured', () => {
    const riskConfig: BacktestConfig = {
      ...config,
      positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
    };

    const quantity = computePositionSize(10000, 100, 'long', riskConfig, []);
    // Risk 1% of 10000 = 100 over a 5% stop distance (5 per unit) = 20 units
    expect(quantity).toBeCloseTo(20);
  });

  it('kelly falls back to fixed percent with fewer than 5 trades', () => {
    const kellyConfig: BacktestConfig = {
      ...config,
      positionSizing: { method: 'kelly', riskPerTrade: 0.01 },
    };

    const quantity = computePositionSize(10000, 100, 'long', kellyConfig, []);
    expect(quantity).toBeCloseTo(10);
  });
});
