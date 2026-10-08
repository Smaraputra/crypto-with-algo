import type { SignalTier } from '@/types/signal';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { TradeSide } from '@/lib/backtest/types';
import type { Breakeven } from '@/lib/costs/breakeven';

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
  /**
   * Raw per-trade sd, in percent: one trade's dispersion (review M6). Null
   * when there is no run.
   */
  sdPercentRaw: number | null;
  /**
   * Effective per-trade sd, in percent, recovered from the run's bootstrap CI
   * (half-width x sqrt(n) / 1.96). It carries the correlation of trades taken
   * at the same time on different symbols, so it is the one that says how
   * many trades a forward record needs. Null when there is no run.
   */
  sdPercentEffective: number | null;
  /** Trades a day across the ten symbols in the run's out-of-sample span. */
  tradesPerDay: number | null;
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
  /** Stop-path round trip in USDT at the ticket's notional. */
  roundTripStopUsdt: number;
  /**
   * The close-to-close move over the recorded median hold, measured on the
   * bars the stop was measured on. Null when the interval has no recorded
   * hold. The stop floor keeps costShareOfRisk near a fifth by construction,
   * so this is the comparison that says whether costs eat the trade.
   */
  holdMove: HoldMove | null;
  /** Stop-path round trip as a fraction of the mean hold move; null without a recorded hold. */
  costShareOfMove: number | null;
  /** Win rate needed after fees and slippage if every trade ended at its stop or target (funding excluded). */
  bracketBreakeven: Breakeven;
}

export interface HoldMove {
  holdBars: number;
  /** Median |close-to-close| return over the hold, percent. */
  medianPercent: number;
  /** Mean |return|, winsorised at the 99th percentile, percent. */
  meanPercent: number;
  independentWindows: number;
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
