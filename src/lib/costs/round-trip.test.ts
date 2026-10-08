import { describe, expect, it } from 'vitest';
import { defaultCostPercent } from '@/lib/backtest/cost-model';
import { feeRatesFor, fundingSettlements, percentToFraction, roundTripCost, type RoundTripInput } from './round-trip';

const HOUR = 3_600_000;

function input(overrides: Partial<RoundTripInput> = {}): RoundTripInput {
  return {
    notional: 1000,
    side: 'long',
    fees: feeRatesFor('standard'),
    entry: 'taker',
    exit: 'taker',
    slippageBps: 3,
    fundingRate: null,
    fundingSettlements: 0,
    ...overrides,
  };
}

describe('feeRatesFor', () => {
  it('prices standard and BNB tiers from the research fee profiles', () => {
    expect(feeRatesFor('standard')).toEqual({ makerFee: 0.0002, takerFee: 0.0005 });
    expect(feeRatesFor('bnb')).toEqual({ makerFee: 0.00018, takerFee: 0.00045 });
  });

  it('reads custom fees as percentages, the way the fee page shows them', () => {
    expect(percentToFraction(0.05)).toBeCloseTo(0.0005, 12);
    const rates = feeRatesFor('custom', { makerPercent: 0.016, takerPercent: 0.04 });
    expect(rates.makerFee).toBeCloseTo(0.00016, 12);
    expect(rates.takerFee).toBeCloseTo(0.0004, 12);
  });

  it('refuses a custom tier without its fees', () => {
    expect(() => feeRatesFor('custom')).toThrow(/custom fee tier/);
  });
});

describe('roundTripCost', () => {
  it('matches the research round trip for taker in, taker out at study slippage', () => {
    const cost = roundTripCost(input({ slippageBps: 3 }));
    expect(cost.totalPercent).toBeCloseTo(defaultCostPercent('1h'), 12);
    expect(cost.feeUsdt).toBeCloseTo(1.0, 12);
    expect(cost.slippageUsdt).toBeCloseTo(0.6, 12);
    expect(cost.totalUsdt).toBeCloseTo(1.6, 12);
    expect(cost.tradingPercent).toBeCloseTo(cost.totalPercent, 12);
  });

  it('matches the trade plan target round trip: taker entry with slippage, maker exit without', () => {
    const cost = roundTripCost(input({ exit: 'maker', slippageBps: 3 }));
    // 0.05% + 0.03% entry, 0.02% exit
    expect(cost.totalPercent).toBeCloseTo(0.1, 12);
    expect(cost.slippagePercent).toBeCloseTo(0.03, 12);
  });

  it('charges longs and credits shorts on a positive funding rate', () => {
    const long = roundTripCost(input({ fundingRate: 0.0001, fundingSettlements: 3 }));
    const short = roundTripCost(input({ side: 'short', fundingRate: 0.0001, fundingSettlements: 3 }));
    expect(long.fundingPercent).toBeCloseTo(0.03, 12);
    expect(long.fundingUsdt).toBeCloseTo(0.3, 12);
    expect(short.fundingPercent).toBeCloseTo(-0.03, 12);
    expect(long.totalPercent - short.totalPercent).toBeCloseTo(0.06, 12);
  });

  it('treats an unknown funding rate as no funding', () => {
    const cost = roundTripCost(input({ fundingRate: null, fundingSettlements: 5 }));
    expect(cost.fundingUsdt).toBe(0);
  });
});

describe('fundingSettlements', () => {
  it('counts settlements in (now, now + hold] on an 8h grid', () => {
    expect(fundingSettlements(0, 24 * HOUR, 8 * HOUR, 8 * HOUR)).toBe(3);
    expect(fundingSettlements(0, 8 * HOUR, 8 * HOUR, 8 * HOUR)).toBe(1);
    expect(fundingSettlements(0, 8 * HOUR - 1, 8 * HOUR, 8 * HOUR)).toBe(0);
  });

  it("uses the symbol's own interval, such as 4h", () => {
    expect(fundingSettlements(0, 24 * HOUR, 4 * HOUR, 4 * HOUR)).toBe(6);
  });

  it('rolls a stale next settlement forward and excludes one exactly at now', () => {
    expect(fundingSettlements(10 * HOUR, 8 * HOUR, 8 * HOUR, 8 * HOUR)).toBe(1);
    expect(fundingSettlements(8 * HOUR, 8 * HOUR, 8 * HOUR, 8 * HOUR)).toBe(1);
  });

  it('returns 0 for a non-positive hold or interval', () => {
    expect(fundingSettlements(0, 0, 8 * HOUR, 8 * HOUR)).toBe(0);
    expect(fundingSettlements(0, 24 * HOUR, 8 * HOUR, 0)).toBe(0);
  });
});
