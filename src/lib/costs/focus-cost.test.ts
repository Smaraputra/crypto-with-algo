import { describe, expect, it } from 'vitest';
import type { CostCheckMarketResponse } from '@/types/cost-check';
import { DEFAULT_INPUTS, type CostCheckInputs } from './cost-check-model';
import { computeFocusCost } from './focus-cost';

const NOW = 1_760_000_000_000;
const HOLD_MINUTES = 240;

function marketFixture(overrides: Partial<CostCheckMarketResponse> = {}): CostCheckMarketResponse {
  return {
    symbol: 'BTCUSDT',
    asOf: 0,
    stale: false,
    markPrice: 60000,
    funding: {
      rate: 0.0001,
      intervalHours: 8,
      nextFundingTime: NOW + 3_600_000,
    },
    venue: {
      minNotional: 100,
      minQty: 0.001,
      stepSize: 0.001,
      tickSize: 0.1,
      effectiveMinNotional: 100,
    },
    measurement: {
      interval: '15m',
      holdBars: 16,
      measuredHoldMs: 14_400_000,
      barsUsed: 1000,
    },
    move: {
      medianPercent: 0.4,
      meanPercent: 0.5,
      p75Percent: 0.7,
      samples: 900,
      independentWindows: 150,
    },
    slippage: {
      bps: 1,
      source: 'depth',
      halfSpreadBps: 0.5,
      exceedsTopOfBook: false,
    },
    onboardDate: 0,
    ...overrides,
  };
}

const baseInputs: CostCheckInputs = {
  ...DEFAULT_INPUTS,
  margin: 100,
  leverage: 10,
};

const baseMarket = marketFixture();

describe('computeFocusCost', () => {
  it('prices the three fill pairs from fees and depth slippage', () => {
    const res = computeFocusCost(baseInputs, baseMarket, HOLD_MINUTES, NOW);

    expect(res.rows[0].label).toBe('Taker in, taker out');
    expect(res.rows[1].label).toBe('Maker in, taker out');
    expect(res.rows[2].label).toBe('Maker in, maker out');

    expect(res.rows[0].costPercent).toBeCloseTo(0.12);
    expect(res.rows[0].costUsdt).toBeCloseTo(1.2);
    expect(res.rows[1].costPercent).toBeCloseTo(0.08);
    expect(res.rows[2].costPercent).toBeCloseTo(0.04);
  });

  it('gives the win rate needed against the mean move', () => {
    const res = computeFocusCost(baseInputs, baseMarket, HOLD_MINUTES, NOW);

    expect(res.rows[0].breakeven?.kind).toBe('possible');
    if (res.rows[0].breakeven?.kind === 'possible') {
      expect(res.rows[0].breakeven.winRate).toBeCloseTo(0.62);
    }

    expect(res.rows[1].breakeven?.kind).toBe('possible');
    if (res.rows[1].breakeven?.kind === 'possible') {
      expect(res.rows[1].breakeven.winRate).toBeCloseTo(0.58);
    }

    expect(res.rows[2].breakeven?.kind).toBe('possible');
    if (res.rows[2].breakeven?.kind === 'possible') {
      expect(res.rows[2].breakeven.winRate).toBeCloseTo(0.54);
    }
  });

  it('marks a cost above the mean move as impossible', () => {
    const market = marketFixture({
      move: { ...baseMarket.move!, meanPercent: 0.1 },
    });
    const res = computeFocusCost(baseInputs, market, HOLD_MINUTES, NOW);

    expect(res.rows[0].breakeven).toEqual({ kind: 'impossible' });
  });

  it('withholds the win rate on a thin move', () => {
    const thinMarket = marketFixture({
      move: { ...baseMarket.move!, independentWindows: 50 },
    });
    const thin = computeFocusCost(baseInputs, thinMarket, HOLD_MINUTES, NOW);
    expect(thin.moveIsThin).toBe(true);
    for (const row of thin.rows) {
      expect(row.breakeven).toBeNull();
    }

    const noMoveMarket = marketFixture({ move: null });
    const noMove = computeFocusCost(baseInputs, noMoveMarket, HOLD_MINUTES, NOW);
    expect(noMove.moveIsThin).toBe(true);
    expect(noMove.move).toBeNull();
    for (const row of noMove.rows) {
      expect(row.breakeven).toBeNull();
    }
  });

  it('reports funding separately with the payer', () => {
    const res = computeFocusCost(baseInputs, baseMarket, HOLD_MINUTES, NOW);
    expect(res.funding).not.toBeNull();
    expect(res.funding?.ratePercent).toBeCloseTo(0.01);
    expect(res.funding?.payer).toBe('longs');
    expect(res.funding?.settlements).toBe(1);
    expect(res.rows[0].costPercent).toBeCloseTo(0.12);

    const shortsMarket = marketFixture({
      funding: { ...baseMarket.funding, rate: -0.0002 },
    });
    const shorts = computeFocusCost(baseInputs, shortsMarket, HOLD_MINUTES, NOW);
    expect(shorts.funding?.payer).toBe('shorts');

    const zeroMarket = marketFixture({
      funding: { ...baseMarket.funding, rate: 0 },
    });
    const zero = computeFocusCost(baseInputs, zeroMarket, HOLD_MINUTES, NOW);
    expect(zero.funding?.payer).toBeNull();
  });

  it('falls back to flat slippage without market data', () => {
    const res = computeFocusCost(baseInputs, null, HOLD_MINUTES, NOW);
    expect(res.slippageSource).toBe('fallback');
    expect(res.slippageBps).toBe(5);
    expect(res.rows[0].costPercent).toBeCloseTo(0.2);
    expect(res.funding).toBeNull();
    for (const row of res.rows) {
      expect(row.breakeven).toBeNull();
    }
  });

  it('honours a saved slippage override', () => {
    const overrideInputs: CostCheckInputs = {
      ...baseInputs,
      slippageOverrideBps: 3,
    };
    const res = computeFocusCost(overrideInputs, baseMarket, HOLD_MINUTES, NOW);
    expect(res.slippageSource).toBe('override');
    expect(res.rows[0].costPercent).toBeCloseTo(0.16);
  });

  it('flags a notional below the venue minimum', () => {
    const lowNotionalInputs: CostCheckInputs = {
      ...baseInputs,
      margin: 5,
      leverage: 1,
    };
    const res = computeFocusCost(lowNotionalInputs, baseMarket, HOLD_MINUTES, NOW);
    expect(res.belowMinNotional).toBe(true);
    expect(res.effectiveMinNotional).toBe(100);
  });
});
