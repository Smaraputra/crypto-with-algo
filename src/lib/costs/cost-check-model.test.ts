import { describe, expect, it } from 'vitest';
import type { CostCheckMarketResponse } from '@/types/cost-check';
import {
  DEFAULT_INPUTS,
  applyUrlParams,
  computeCostCheck,
  formatHold,
  notionalOf,
  parseStoredInputs,
  type CostCheckInputs,
} from './cost-check-model';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 7, 9, 30);

function market(overrides: Partial<CostCheckMarketResponse> = {}): CostCheckMarketResponse {
  return {
    symbol: 'BTCUSDT',
    asOf: NOW,
    stale: false,
    markPrice: 60_000,
    funding: { rate: 0.0001, intervalHours: 8, nextFundingTime: Date.UTC(2026, 9, 7, 16) },
    venue: { minNotional: 50, minQty: 0.001, stepSize: 0.001, tickSize: 0.1, effectiveMinNotional: 60 },
    measurement: { interval: '15m', holdBars: 4, measuredHoldMs: HOUR, barsUsed: 999 },
    move: { medianPercent: 0.3, meanPercent: 0.4, p75Percent: 0.55, samples: 995, independentWindows: 249 },
    slippage: { bps: 1, source: 'depth', halfSpreadBps: 0.1, exceedsTopOfBook: false },
    onboardDate: 0,
    ...overrides,
  };
}

function inputs(overrides: Partial<CostCheckInputs> = {}): CostCheckInputs {
  return { ...DEFAULT_INPUTS, ...overrides };
}

describe('computeCostCheck', () => {
  it('prices the default 1h BTC trade at 10x with measured slippage', () => {
    const m = computeCostCheck(inputs(), market(), NOW);
    expect(m.notional).toBe(1000);
    expect(m.slippageSource).toBe('depth');
    // taker 0.05% x 2 + 1 bp x 2 = 0.12%; no settlement between 09:30 and 10:30
    expect(m.settlements).toBe(0);
    expect(m.roundTrip.totalPercent).toBeCloseTo(0.12, 12);
    expect(m.verdictCostUsdt).toBeCloseTo(1.2, 12);
    // 0.5 + 0.12 / (2 x 0.4) = 0.65
    expect(m.verdict).toEqual({ kind: 'verdict', tone: 'dominate', breakeven: { kind: 'possible', winRate: expect.closeTo(0.65, 12) } });
    expect(m.costPercentOfMargin).toBeCloseTo(1.2, 12);
    expect(m.liquidationDistancePercent).toBeCloseTo(9.6, 12);
  });

  it('charges paid funding in the verdict but does not credit a receipt', () => {
    const long = computeCostCheck(inputs({ holdMinutes: 24 * 60 }), market(), NOW);
    const short = computeCostCheck(inputs({ holdMinutes: 24 * 60, side: 'short' }), market(), NOW);
    expect(long.settlements).toBe(3); // 16:00, 00:00, 08:00
    expect(long.roundTrip.fundingPercent).toBeCloseTo(0.03, 12);
    expect(long.verdictCostPercent).toBeCloseTo(0.15, 12);
    expect(short.roundTrip.fundingPercent).toBeCloseTo(-0.03, 12);
    expect(short.verdictCostPercent).toBeCloseTo(0.12, 12);
  });

  it('uses an override before the book, and the flat fallback without either', () => {
    expect(computeCostCheck(inputs({ slippageOverrideBps: 3 }), market(), NOW).slippageBps).toBe(3);
    const fallback = computeCostCheck(
      inputs(),
      market({ slippage: { bps: 5, source: 'fallback', halfSpreadBps: null, exceedsTopOfBook: false } }),
      NOW
    );
    expect(fallback.slippageSource).toBe('fallback');
    expect(fallback.slippageBps).toBe(5);
  });

  it('reports costs that exceed the typical move', () => {
    const m = computeCostCheck(inputs(), market({ move: { medianPercent: 0.05, meanPercent: 0.08, p75Percent: 0.1, samples: 995, independentWindows: 249 } }), NOW);
    expect(m.verdict).toEqual({ kind: 'verdict', tone: 'exceed', breakeven: { kind: 'impossible' } });
  });

  it('withholds the verdict on thin history and without market data', () => {
    const thin = computeCostCheck(inputs(), market({ move: { medianPercent: 0.3, meanPercent: 0.4, p75Percent: 0.5, samples: 200, independentWindows: 50 } }), NOW);
    expect(thin.verdict).toEqual({ kind: 'thin', independentWindows: 50 });
    expect(computeCostCheck(inputs(), market({ move: null }), NOW).verdict).toEqual({ kind: 'thin', independentWindows: 0 });
    const none = computeCostCheck(inputs(), null, NOW);
    expect(none.verdict).toEqual({ kind: 'no-market' });
    expect(none.slippageBps).toBe(5);
    expect(none.roundTrip.fundingPercent).toBe(0);
  });

  it('flags an order below the venue minimum', () => {
    expect(computeCostCheck(inputs({ margin: 5, leverage: 10 }), market(), NOW).belowMinNotional).toBe(true);
    expect(computeCostCheck(inputs({ margin: 6, leverage: 10 }), market(), NOW).belowMinNotional).toBe(false);
  });

  it('adds the verdict cost up over a month of trades', () => {
    const m = computeCostCheck(inputs({ tradesPerDay: 10, equity: 1000 }), market(), NOW);
    expect(m.burn.perMonthUsdt).toBeCloseTo(10 * 1.2 * (365 / 12), 9);
    expect(m.burn.percentOfEquity).toBeCloseTo((10 * 1.2 * (365 / 12)) / 10, 9);
  });

  it('prices a custom maker and taker fee typed in percent', () => {
    const m = computeCostCheck(inputs({ feeTier: 'custom', customMakerPercent: 0, customTakerPercent: 0.04, entry: 'maker' }), market(), NOW);
    // maker entry 0% with no slippage, taker exit 0.04% + 1 bp
    expect(m.roundTrip.totalPercent).toBeCloseTo(0.05, 12);
  });
});

describe('inputs', () => {
  it('falls back to defaults for missing, corrupt or out-of-range storage', () => {
    expect(parseStoredInputs(null)).toEqual(DEFAULT_INPUTS);
    expect(parseStoredInputs('{not json')).toEqual(DEFAULT_INPUTS);
    expect(parseStoredInputs(JSON.stringify({ ...DEFAULT_INPUTS, leverage: 500 }))).toEqual(DEFAULT_INPUTS);
  });

  it('restores valid saved inputs and fills fields added since they were saved', () => {
    const { tradesPerDay: _omitted, ...older } = { ...DEFAULT_INPUTS, symbol: 'ETHUSDT', leverage: 3 };
    void _omitted;
    const restored = parseStoredInputs(JSON.stringify(older));
    expect(restored.symbol).toBe('ETHUSDT');
    expect(restored.leverage).toBe(3);
    expect(restored.tradesPerDay).toBe(DEFAULT_INPUTS.tradesPerDay);
  });

  it('lets URL parameters win and reads a notional at 1x', () => {
    const next = applyUrlParams(DEFAULT_INPUTS, new URLSearchParams('symbol=SOLUSDT&holdMinutes=420&notional=248&side=short'));
    expect(next).toMatchObject({ symbol: 'SOLUSDT', holdMinutes: 420, margin: 248, leverage: 1, side: 'short' });
    expect(notionalOf(next)).toBe(248);
  });

  it('ignores invalid URL parameters', () => {
    const next = applyUrlParams(DEFAULT_INPUTS, new URLSearchParams('symbol=btc/usdt&holdMinutes=0&notional=-5&side=up'));
    expect(next).toEqual(DEFAULT_INPUTS);
  });

  it('formats holds in words', () => {
    expect(formatHold(5)).toBe('5m');
    expect(formatHold(60)).toBe('1h');
    expect(formatHold(90)).toBe('1h 30m');
    expect(formatHold(1440)).toBe('1d');
    expect(formatHold(3000)).toBe('2d 2h');
  });
});
