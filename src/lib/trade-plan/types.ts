import type { SignalTier } from '@/types/signal';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { TradeSide } from '@/lib/backtest/types';

/**
 * Shapes of the trade plan the /signals card renders.
 *
 * Type-only module: the card imports these without pulling the server-side
 * builder (and its model imports) into the client bundle.
 */

/** Binance USDT-M perpetual order filters for one symbol. */
export interface VenueFilter {
  symbol: string;
  /** Quantity increment for market and limit orders (MARKET_LOT_SIZE equals LOT_SIZE for every symbol here). */
  stepSize: number;
  minQty: number;
  /** MIN_NOTIONAL filter, in USDT. */
  minNotional: number;
  tickSize: number;
}

/** How much of the research record describes this interval under today's rule. */
export type EvidenceStatus = 'current' | 'stale' | 'none';

/**
 * The recorded out-of-sample result of the research `control` family, which
 * is the same rule the ticket describes, at one interval.
 */
export interface ControlEvidence {
  interval: string;
  status: EvidenceStatus;
  /** Short name of the run, e.g. "v7 control, 2026-09-26". */
  label: string;
  /** Where the number came from: dataset, commit or image, thresholds. */
  provenance: string;
  /** Entry and exit levels the run used; null when there is no run. */
  thresholds: { entry: number; exit: number } | null;
  trades: number | null;
  /** Pooled out-of-sample expectancy per trade after costs, in percent. */
  expectancyPercent: number | null;
  /** Bootstrap 95% bounds in percent; the Phase 4 table recorded only the low bound. */
  ciLowPercent: number | null;
  ciHighPercent: number | null;
  medianHoldBars: number | null;
  verdict: string;
  /**
   * The scorer configVersion the run was measured under; null for a run on
   * the scorer before v5 (whose version and thresholds both differ) or for no
   * run. The card's badge label is derived from it, so a re-measurement under
   * a new scorer changes data, not strings.
   */
  configVersion: number | null;
}

/** Cost of one round trip, every figure a percent of entry notional. */
export interface TicketCosts {
  entryFeePercent: number;
  entrySlippagePercent: number;
  /** Stop exit: a taker fill that slips. */
  stopExitPercent: number;
  /** Target exit: a resting maker fill that does not slip. */
  targetExitPercent: number;
  roundTripStopPercent: number;
  roundTripTargetPercent: number;
  /** Expected funding over the recorded median hold; positive means the position pays. Null when unknown. */
  fundingPercent: number | null;
  fundingRate: number | null;
  expectedFundingCrossings: number | null;
  /** Stop-path round trip as a fraction of the stop distance: 0.2 means costs are a fifth of the risk. */
  costShareOfRisk: number;
}

export interface TradeTicket {
  side: TradeSide;
  /** Close of the signal bar: the price the stop and target are measured from. */
  referencePrice: number;
  /** The fill the research engine books: the signal close after entry slippage. Live, the order fills at the next open. */
  modelEntryPrice: number;
  stopPrice: number;
  targetPrice: number;
  stopPercent: number;
  targetPercent: number;
  medianTrueRangePercent: number;
  quantity: number;
  /** Display precision from the venue's tick and step, so prices and sizes show as an order would carry them. */
  priceDecimals: number;
  quantityDecimals: number;
  notional: number;
  leverage: number;
  /** Currency lost at the stop before costs. */
  riskAmount: number;
  placeable: boolean;
  notPlaceableReason: string | null;
  costs: TicketCosts;
}

export interface TradePlan {
  symbol: string;
  style: TradingStyle;
  interval: string;
  signal: {
    score: number;
    tier: SignalTier;
    candleTimestamp: number;
    closeTime: number;
    configVersion: number;
    createdAt: string;
  };
  rule: {
    entryThreshold: number;
    exitThreshold: number;
    shortEntryThreshold: number;
    shortExitThreshold: number;
    stopWindowBars: number;
    riskPerTrade: number;
    equity: number;
  };
  /** The ticket when the rule enters on this bar's score; null when it stays flat. */
  entry: TradeTicket | null;
  /** Whether a position opened on an earlier bar would close on this bar's score. */
  holding: { longExits: boolean; shortExits: boolean };
  evidence: ControlEvidence;
  notes: string[];
}

/** One tier of the live outcome record, net of a fixed round-trip cost. */
export interface LiveTierRecord {
  tier: SignalTier;
  count: number;
  expectancyPercent: number;
  winRate: number;
}

/**
 * The live SignalOutcome record for one style and interval. It is a
 * close-to-close return over a fixed hold with no stop or target, so it
 * measures the score's direction, not the ticket's rule.
 */
export interface LiveRecord {
  configVersion: number;
  horizonBars: number;
  costPercentRoundTrip: number;
  tiers: LiveTierRecord[];
}

/** The paper desk's actual open position for this book and symbol. */
export interface DeskPositionView {
  side: TradeSide;
  entryPrice: number;
  entryTime: number;
  quantity: number;
  stopPrice: number;
  targetPrice: number | null;
  entryScore: number;
  /** Whether this bar's score closes it under the rule. */
  exitsNow: boolean;
  /** Unrealised pnl at the signal bar's close, in percent of entry notional. */
  unrealisedPercent: number;
}

export interface TradePlanResponse {
  plan: TradePlan | null;
  /** Why no plan could be built, when plan is null. */
  unavailableReason: string | null;
  liveRecord: LiveRecord | null;
  /** The desk's real position, when the paper desk holds one. Null when flat. */
  deskPosition: DeskPositionView | null;
}
