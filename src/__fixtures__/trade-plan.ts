import type { DeskPositionView, TradePlan, TradePlanResponse, TradeTicket } from '@/lib/trade-plan/types';
import { CONTROL_EVIDENCE } from '@/lib/trade-plan/evidence';

/** A long SOLUSDT ticket on a 1h bar with a 4% stop and an 8% target, as buildTradePlan produces it. */
export function makeTicket(overrides: Partial<TradeTicket> = {}): TradeTicket {
  return {
    side: 'long',
    referencePrice: 100,
    modelEntryPrice: 100.03,
    stopPrice: 96,
    targetPrice: 108,
    stopPercent: 4,
    targetPercent: 8,
    medianTrueRangePercent: 2,
    quantity: 2.48,
    priceDecimals: 2,
    quantityDecimals: 2,
    notional: 248,
    leverage: 0.248,
    riskAmount: 9.9944,
    placeable: true,
    notPlaceableReason: null,
    costs: {
      entryFeePercent: 0.05,
      entrySlippagePercent: 0.03,
      stopExitPercent: 0.08,
      targetExitPercent: 0.02,
      roundTripStopPercent: 0.16,
      roundTripTargetPercent: 0.1,
      fundingPercent: 0.00875,
      fundingRate: 0.0001,
      expectedFundingCrossings: 0.875,
      costShareOfRisk: 0.04,
      roundTripStopUsdt: 0.3968,
      holdMove: { holdBars: 7, medianPercent: 0.9, meanPercent: 1.1, independentWindows: 142 },
      costShareOfMove: 0.16 / 1.1,
      bracketBreakeven: { kind: 'possible', winRate: 4.16 / (4.16 + 7.9) },
    },
    ...overrides,
  };
}

export function makeTradePlan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    symbol: 'SOLUSDT',
    style: 'day_trading',
    interval: '1h',
    signal: {
      score: 35.2,
      tier: 'buy',
      candleTimestamp: Date.UTC(2026, 9, 1, 13),
      closeTime: Date.UTC(2026, 9, 1, 14),
      configVersion: 7,
      createdAt: '2026-10-01T14:01:05.000Z',
    },
    rule: {
      entryThreshold: 29,
      exitThreshold: 7.25,
      shortEntryThreshold: -29,
      shortExitThreshold: -7.25,
      stopWindowBars: 1000,
      riskPerTrade: 0.01,
      equity: 1000,
    },
    entry: makeTicket(),
    holding: { longExits: false, shortExits: true },
    evidence: CONTROL_EVIDENCE['1h'],
    notes: [],
    ...overrides,
  };
}

/** The paper desk holding a long, as the trade-plan API projects it. */
export function makeDeskPosition(overrides: Partial<DeskPositionView> = {}): DeskPositionView {
  return {
    side: 'long',
    entryPrice: 100.03,
    entryTime: Date.UTC(2026, 9, 1, 10),
    quantity: 2.48,
    stopPrice: 96,
    targetPrice: 108,
    entryScore: 31.4,
    exitsNow: false,
    unrealisedPercent: -0.03,
    ...overrides,
  };
}

export function makeTradePlanResponse(overrides: Partial<TradePlanResponse> = {}): TradePlanResponse {
  return {
    plan: makeTradePlan(),
    unavailableReason: null,
    deskPosition: null,
    liveRecord: {
      configVersion: 7,
      horizonBars: 24,
      costPercentRoundTrip: 0.16,
      tiers: [
        { tier: 'buy', count: 412, expectancyPercent: -0.051, winRate: 0.482 },
        { tier: 'strong_buy', count: 57, expectancyPercent: 0.12, winRate: 0.53 },
      ],
    },
    ...overrides,
  };
}
