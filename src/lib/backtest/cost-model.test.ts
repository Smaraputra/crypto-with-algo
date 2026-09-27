// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  BINANCE_FUTURES_MAKER_FEE,
  BINANCE_FUTURES_TAKER_FEE,
  STUDY_SLIPPAGE_BPS,
  DEFAULT_FEE_PROFILE,
  FEE_PROFILES,
  FEE_PROFILE_NAMES,
  studyCostConfig,
  defaultCostPercent,
  feeRateFor,
  applySlippage,
  exitFillKind,
  exitSlippageApplies,
  isFeeProfileName,
  resolveFeeProfile,
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

  it('time_stop is taker', () => {
    expect(exitFillKind('time_stop')).toBe('taker');
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

  it('applies to time_stop', () => {
    expect(exitSlippageApplies('time_stop')).toBe(true);
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

describe('defaultCostPercent', () => {
  it('is two taker legs plus slippage on both, in percent', () => {
    // 1h: 2 x 0.05% fee + 2 x 3bps slippage = 0.10% + 0.06% = 0.16%.
    expect(defaultCostPercent('1h')).toBeCloseTo(0.16, 10);
    expect(defaultCostPercent('5m')).toBeCloseTo(0.2, 10);
    expect(defaultCostPercent('4h')).toBeCloseTo(0.14, 10);
  });

  it('throws on an interval with no slippage budget rather than costing zero', () => {
    // A silent 0 here would make a losing rule look break-even.
    expect(() => defaultCostPercent('3d')).toThrow(/No slippage budget/);
  });
});

describe('fee profiles', () => {
  it('standard is the recorded VIP 0 schedule and the default', () => {
    expect(DEFAULT_FEE_PROFILE).toBe('standard');
    expect(FEE_PROFILES.standard.makerFee).toBe(BINANCE_FUTURES_MAKER_FEE);
    expect(FEE_PROFILES.standard.takerFee).toBe(BINANCE_FUTURES_TAKER_FEE);
    expect(FEE_PROFILE_NAMES).toEqual(['standard', 'bnb', 'promo-btc-eth-2026-07']);
  });
  it('bnb is ten percent off both sides', () => {
    expect(FEE_PROFILES.bnb.makerFee).toBeCloseTo(0.00018, 8);
    expect(FEE_PROFILES.bnb.takerFee).toBeCloseTo(0.00045, 8);
  });
  it('the 2026-07 promotion is zero maker and 0.036% taker for BTCUSDT and ETHUSDT only', () => {
    expect(resolveFeeProfile('promo-btc-eth-2026-07', 'BTCUSDT')).toMatchObject({ makerFee: 0, takerFee: 0.00036 });
    expect(resolveFeeProfile('promo-btc-eth-2026-07', 'ETHUSDT')).toMatchObject({ makerFee: 0, takerFee: 0.00036 });
  });
  it('an alt under the promotion falls back to bnb, never to zero fees', () => {
    expect(resolveFeeProfile('promo-btc-eth-2026-07', 'SOLUSDT').name).toBe('bnb');
    expect(resolveFeeProfile('promo-btc-eth-2026-07').name).toBe('bnb');
  });
  it('rejects an unknown profile name', () => {
    expect(() => resolveFeeProfile('vip9' as never)).toThrow(/Unknown fee profile/);
    expect(isFeeProfileName('bnb')).toBe(true);
    expect(isFeeProfileName('vip9')).toBe(false);
  });
});

describe('studyCostConfig with profiles', () => {
  it('is byte-identical to the historical call without options', () => {
    expect(studyCostConfig('1h')).toEqual({
      feePercent: 0.0005,
      makerFeePercent: 0.0002,
      takerFeePercent: 0.0005,
      slippageBps: 3,
    });
    expect(studyCostConfig('1h', {})).toEqual(studyCostConfig('1h'));
    expect(studyCostConfig('1h', { profile: 'standard', symbol: 'BTCUSDT' })).toEqual(studyCostConfig('1h'));
  });
  it('prices BTCUSDT under the promotion at zero maker and keeps the slippage budget', () => {
    expect(studyCostConfig('15m', { profile: 'promo-btc-eth-2026-07', symbol: 'BTCUSDT' })).toEqual({
      feePercent: 0.00036,
      makerFeePercent: 0,
      takerFeePercent: 0.00036,
      slippageBps: 3,
    });
  });
  it('still throws on an interval with no slippage budget', () => {
    expect(() => studyCostConfig('2h')).toThrow(/No slippage budget/);
  });
});

describe('defaultCostPercent with profiles', () => {
  it('reproduces the recorded round trips under standard', () => {
    expect(defaultCostPercent('5m')).toBeCloseTo(0.2, 10);
    expect(defaultCostPercent('1h')).toBeCloseTo(0.16, 10);
    expect(defaultCostPercent('4h')).toBeCloseTo(0.14, 10);
  });
  it('is 0.132 at 1h for BTCUSDT under the promotion and 0.15 under bnb', () => {
    expect(defaultCostPercent('1h', { profile: 'promo-btc-eth-2026-07', symbol: 'BTCUSDT' })).toBeCloseTo(0.132, 10);
    expect(defaultCostPercent('1h', { profile: 'bnb' })).toBeCloseTo(0.15, 10);
  });
});
