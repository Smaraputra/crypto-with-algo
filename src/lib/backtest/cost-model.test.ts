// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  BINANCE_FUTURES_MAKER_FEE,
  BINANCE_FUTURES_TAKER_FEE,
  STUDY_SLIPPAGE_BPS,
  studyCostConfig,
  feeRateFor,
  applySlippage,
  exitFillKind,
  exitSlippageApplies,
} from './cost-model';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { BacktestConfig } from './types';

const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG };

describe('feeRateFor', () => {
  it('falls back to feePercent for maker when makerFeePercent is absent', () => {
    expect(feeRateFor('maker', config)).toBe(config.feePercent);
  });

  it('falls back to feePercent for taker when takerFeePercent is absent', () => {
    expect(feeRateFor('taker', config)).toBe(config.feePercent);
  });

  it('uses makerFeePercent when present', () => {
    const withMaker: BacktestConfig = { ...config, makerFeePercent: 0.0002 };
    expect(feeRateFor('maker', withMaker)).toBe(0.0002);
  });

  it('uses takerFeePercent when present', () => {
    const withTaker: BacktestConfig = { ...config, takerFeePercent: 0.0005 };
    expect(feeRateFor('taker', withTaker)).toBe(0.0005);
  });

  it('ignores makerFeePercent when asking for taker rate', () => {
    const mixed: BacktestConfig = { ...config, makerFeePercent: 0.0002 };
    expect(feeRateFor('taker', mixed)).toBe(config.feePercent);
  });
});

describe('applySlippage', () => {
  it('moves a buy fill up by the slippage bps', () => {
    expect(applySlippage(100, 'buy', 5)).toBeCloseTo(100.05);
  });

  it('moves a sell fill down by the slippage bps', () => {
    expect(applySlippage(100, 'sell', 5)).toBeCloseTo(99.95);
  });

  it('returns the price unchanged when slippageBps is undefined', () => {
    expect(applySlippage(100, 'buy', undefined)).toBe(100);
    expect(applySlippage(100, 'sell', undefined)).toBe(100);
  });

  it('returns the price unchanged when slippageBps is 0', () => {
    expect(applySlippage(100, 'buy', 0)).toBe(100);
    expect(applySlippage(100, 'sell', 0)).toBe(100);
  });
});

describe('exitFillKind', () => {
  it('take_profit is maker', () => {
    expect(exitFillKind('take_profit')).toBe('maker');
  });

  it('stop_loss is taker', () => {
    expect(exitFillKind('stop_loss')).toBe('taker');
  });

  it('signal is taker', () => {
    expect(exitFillKind('signal')).toBe('taker');
  });

  it('end_of_data is taker', () => {
    expect(exitFillKind('end_of_data')).toBe('taker');
  });
});

describe('exitSlippageApplies', () => {
  it('applies to stop_loss', () => {
    expect(exitSlippageApplies('stop_loss')).toBe(true);
  });

  it('applies to signal', () => {
    expect(exitSlippageApplies('signal')).toBe(true);
  });

  it('does not apply to take_profit', () => {
    expect(exitSlippageApplies('take_profit')).toBe(false);
  });

  it('does not apply to end_of_data', () => {
    expect(exitSlippageApplies('end_of_data')).toBe(false);
  });
});

describe('studyCostConfig', () => {
  it.each(Object.keys(STUDY_SLIPPAGE_BPS))('returns Binance futures costs for %s', (interval) => {
    const result = studyCostConfig(interval);
    expect(result).toEqual({
      feePercent: BINANCE_FUTURES_TAKER_FEE,
      makerFeePercent: BINANCE_FUTURES_MAKER_FEE,
      takerFeePercent: BINANCE_FUTURES_TAKER_FEE,
      slippageBps: STUDY_SLIPPAGE_BPS[interval],
    });
  });

  it('throws on an unknown interval', () => {
    expect(() => studyCostConfig('3m')).toThrow();
  });
});
