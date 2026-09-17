// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  accrueFunding,
  checkStopTakeProfit,
  closeTrade,
  computeEquityAfterTrade,
  computePositionSize,
  openPosition,
  type OpenPosition,
} from './trade-utils';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { BacktestConfig, BacktestTrade } from './types';
import type { EntryDecision } from './strategy';
import type { OHLCV } from '@/types/market';

// Defaults mirror the score-threshold strategy's default config: a long 5%
// below entry for the stop, 10% above for the target.
const makePosition = (overrides: Partial<OpenPosition> = {}): OpenPosition => ({
  entryBar: 10,
  entryTime: 1700000000000,
  entryPrice: 100,
  side: 'long',
  quantity: 10,
  entryScore: 50,
  entryTier: 'buy',
  stopPrice: 95,
  targetPrice: 110,
  timeStopBars: null,
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
    const candle = makeCandle({ low: 94.9 }); // SL at 95

    const { exitReason, exitPrice } = checkStopTakeProfit(position, candle);
    expect(exitReason).toBe('stop_loss');
    expect(exitPrice).toBeCloseTo(95);
  });

  it('triggers long take profit when high crosses TP price', () => {
    const position = makePosition();
    const candle = makeCandle({ high: 110.1 }); // TP at 110

    const { exitReason, exitPrice } = checkStopTakeProfit(position, candle);
    expect(exitReason).toBe('take_profit');
    expect(exitPrice).toBeCloseTo(110);
  });

  it('stop loss wins when both SL and TP hit in the same bar', () => {
    const position = makePosition();
    const candle = makeCandle({ low: 94, high: 111 });

    const { exitReason } = checkStopTakeProfit(position, candle);
    expect(exitReason).toBe('stop_loss');
  });

  it('handles short positions with inverted levels', () => {
    const position = makePosition({ side: 'short', stopPrice: 105, targetPrice: 90 });
    const slCandle = makeCandle({ high: 105.1 }); // short SL at 105
    const tpCandle = makeCandle({ low: 89.9 }); // short TP at 90

    expect(checkStopTakeProfit(position, slCandle).exitReason).toBe('stop_loss');
    expect(checkStopTakeProfit(position, tpCandle).exitReason).toBe('take_profit');
  });

  it('returns null when neither level is hit', () => {
    const position = makePosition();
    const candle = makeCandle();

    expect(checkStopTakeProfit(position, candle).exitReason).toBeNull();
  });

  it('a null targetPrice never triggers take_profit, however high the bar runs', () => {
    const position = makePosition({ targetPrice: null });
    const candle = makeCandle({ high: 1000 });

    expect(checkStopTakeProfit(position, candle).exitReason).toBeNull();
  });

  it('reads stop and target from the position, independent of config percentages', () => {
    // config still carries the default 5%/10%, but the position's own absolute
    // prices are what checkStopTakeProfit must use
    const position = makePosition({ stopPrice: 80, targetPrice: 130 });

    expect(checkStopTakeProfit(position, makeCandle({ low: 94.9 })).exitReason).toBeNull();
    expect(checkStopTakeProfit(position, makeCandle({ low: 79.9 })).exitReason).toBe('stop_loss');
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

describe('accrueFunding', () => {
  it('adds signed funding pnl for the crossings between prevCloseTime and closeTime', () => {
    const position = makePosition({ quantity: 10 });
    const candle = makeCandle({ close: 100 });

    accrueFunding(position, candle, 7 * 3600000, 8 * 3600000, 0.0001);

    // 1 crossing, notional 10*100=1000, long pays: -1000*0.0001*1 = -0.1
    expect(position.fundingPnl).toBeCloseTo(-0.1);
  });

  it('accumulates across multiple calls', () => {
    const position = makePosition({ quantity: 10 });
    const candle = makeCandle({ close: 100 });

    accrueFunding(position, candle, 7 * 3600000, 8 * 3600000, 0.0001);
    accrueFunding(position, candle, 15 * 3600000, 16 * 3600000, 0.0001);

    expect(position.fundingPnl).toBeCloseTo(-0.2);
  });

  it('adds nothing when no crossing falls in the window', () => {
    const position = makePosition({ quantity: 10 });
    const candle = makeCandle({ close: 100 });

    accrueFunding(position, candle, 1 * 3600000, 2 * 3600000, 0.0001);

    expect(position.fundingPnl ?? 0).toBeCloseTo(0);
  });

  it('a short receives funding on a positive rate', () => {
    const position = makePosition({ side: 'short', quantity: 10 });
    const candle = makeCandle({ close: 100 });

    accrueFunding(position, candle, 7 * 3600000, 8 * 3600000, 0.0001);

    expect(position.fundingPnl).toBeCloseTo(0.1);
  });
});

describe('closeTrade funding', () => {
  it('folds accumulated fundingPnl into pnl and pnlPercent', () => {
    const position = makePosition({ fundingPnl: -0.5 }); // 10 units at 100
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'take_profit', 0, trades, config);

    // Gross net of fees is 97.9 (see the cost-model take_profit case above); funding subtracts 0.5 more
    expect(trades[0].pnl).toBeCloseTo(97.4);
    expect(trades[0].pnlPercent).toBeCloseTo(9.74);
  });

  it('records fundingCost as the negative of the accumulated fundingPnl', () => {
    const position = makePosition({ fundingPnl: -0.5 });
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'take_profit', 0, trades, config);

    expect(trades[0].fundingCost).toBeCloseTo(0.5);
  });

  it('a short position that received funding gets a negative fundingCost', () => {
    const position = makePosition({ side: 'short', fundingPnl: 0.5 });
    const trades: BacktestTrade[] = [];

    closeTrade(position, 90, 20, 1700003600000, 'take_profit', 0, trades, config);

    expect(trades[0].fundingCost).toBeCloseTo(-0.5);
  });

  it('fundingCost is 0 when fundingPnl was never accrued', () => {
    const position = makePosition();
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'take_profit', 0, trades, config);

    expect(trades[0].fundingCost).toBe(0);
  });
});

describe('computeEquityAfterTrade', () => {
  it('adds trade pnl to equity', () => {
    const trade = { pnl: 250 } as BacktestTrade;
    expect(computeEquityAfterTrade(10000, trade)).toBe(10250);
  });
});

describe('computePositionSize', () => {
  it('uses fixed percent by default, ignoring the supplied stop price', () => {
    const quantity = computePositionSize(10000, 100, 'long', config, [], 95);
    // 10% of 10000 = 1000 notional at price 100 = 10 units
    expect(quantity).toBeCloseTo(10);
  });

  it('uses risk-based sizing from the caller-supplied stop price', () => {
    const riskConfig: BacktestConfig = {
      ...config,
      positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
    };

    const quantity = computePositionSize(10000, 100, 'long', riskConfig, [], 95);
    // Risk 1% of 10000 = 100 over a 5-point stop distance (5 per unit) = 20 units
    expect(quantity).toBeCloseTo(20);
  });

  it('risk-based sizing tracks the stop price, not config.stopLossPercent', () => {
    const riskConfig: BacktestConfig = {
      ...config,
      positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
      stopLossPercent: 0.05, // would imply a 5-point stop; the caller supplies 10 instead
    };

    const quantity = computePositionSize(10000, 100, 'long', riskConfig, [], 90);
    // Risk 1% of 10000 = 100 over a 10-point stop distance = 10 units
    expect(quantity).toBeCloseTo(10);
  });

  it('kelly falls back to fixed percent with fewer than 5 trades', () => {
    const kellyConfig: BacktestConfig = {
      ...config,
      positionSizing: { method: 'kelly', riskPerTrade: 0.01 },
    };

    const quantity = computePositionSize(10000, 100, 'long', kellyConfig, [], 95);
    expect(quantity).toBeCloseTo(10);
  });
});

describe('closeTrade risk percent', () => {
  it('computes riskPercent from the position stop distance, not config.stopLossPercent', () => {
    const position = makePosition({ stopPrice: 90 }); // 10% away from entryPrice 100
    const trades: BacktestTrade[] = [];

    closeTrade(position, 110, 20, 1700003600000, 'take_profit', 0, trades, config);

    expect(trades[0].riskPercent).toBeCloseTo(10);
  });

  it('computes riskPercent for a short from the stop distance above entry', () => {
    const position = makePosition({ side: 'short', stopPrice: 108, targetPrice: 90 }); // 8% away
    const trades: BacktestTrade[] = [];

    closeTrade(position, 90, 20, 1700003600000, 'take_profit', 0, trades, config);

    expect(trades[0].riskPercent).toBeCloseTo(8);
  });
});

describe('openPosition', () => {
  const decision: EntryDecision = {
    side: 'long',
    orderType: 'market',
    stopPrice: 95,
    targetPrice: 110,
    timeStopBars: null,
  };

  it('builds an OpenPosition from a market fill', () => {
    const position = openPosition(
      decision,
      { price: 100, bar: 5, time: 1700000000000, kind: 'taker' },
      10000,
      config,
      [],
      42,
      'buy',
      'new_york'
    );

    expect(position).toEqual({
      entryBar: 5,
      entryTime: 1700000000000,
      entryPrice: 100,
      side: 'long',
      quantity: 10, // 10% fixed-percent default: 1000 / 100
      entryScore: 42,
      entryTier: 'buy',
      entrySession: 'new_york',
      entryFillKind: 'taker',
      stopPrice: 95,
      targetPrice: 110,
      timeStopBars: null,
    });
  });

  it('sizes the position from the decision stop price under risk-based sizing', () => {
    const riskConfig: BacktestConfig = {
      ...config,
      positionSizing: { method: 'risk_based', riskPerTrade: 0.01 },
    };

    const position = openPosition(
      decision,
      { price: 100, bar: 5, time: 1700000000000, kind: 'maker' },
      10000,
      riskConfig,
      [],
      42,
      'buy',
      null
    );

    // Risk 1% of 10000 = 100 over a 5-point stop distance = 20 units
    expect(position.quantity).toBeCloseTo(20);
    expect(position.entryFillKind).toBe('maker');
  });

  it('defaults timeStopBars to null when the decision omits it', () => {
    const marketDecision: EntryDecision = {
      side: 'short',
      orderType: 'market',
      stopPrice: 105,
      targetPrice: 90,
    };

    const position = openPosition(
      marketDecision,
      { price: 100, bar: 0, time: 0, kind: 'taker' },
      10000,
      config,
      [],
      -40,
      'sell',
      null
    );

    expect(position.timeStopBars).toBeNull();
  });

  it('carries a decision timeStopBars through unchanged', () => {
    const timedDecision: EntryDecision = {
      side: 'long',
      orderType: 'limit',
      limitPrice: 99,
      stopPrice: 95,
      targetPrice: 110,
      timeStopBars: 10,
    };

    const position = openPosition(
      timedDecision,
      { price: 99, bar: 3, time: 1700000000000, kind: 'maker' },
      10000,
      config,
      [],
      30,
      'buy',
      null
    );

    expect(position.timeStopBars).toBe(10);
    expect(position.entryPrice).toBe(99);
  });
});
