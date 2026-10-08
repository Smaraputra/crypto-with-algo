import type { OHLCV } from '@/types/market';
import type { SignalTier } from '@/types/signal';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { StrategyContext } from '@/lib/backtest/strategy';
import type { BacktestConfig, TradeSide } from '@/lib/backtest/types';
import { computePositionSize, type OpenPosition } from '@/lib/backtest/trade-utils';
import { applySlippage, exitFillKind, exitSlippageApplies, feeRateFor } from '@/lib/backtest/cost-model';
import { FUNDING_INTERVAL_MS } from '@/lib/backtest/funding';
import { intervalToMs } from '@/lib/intervals';
import { bracketBreakeven } from '@/lib/costs/breakeven';
import { holdMoveStats } from '@/lib/costs/move';
import { evidenceFor } from './evidence';
import {
  DEFAULT_TICKET_EQUITY,
  RISK_PER_TRADE,
  STOP_WINDOW_BARS,
  TRADE_PLAN_STRATEGY,
  stopsFor,
  tradePlanConfig,
} from './rule';
import { decimalsOf, placeability, roundPrice, roundQty, venueFilterFor } from './venue';
import type { ControlEvidence, HoldMove, TicketCosts, TradePlan, TradeTicket } from './types';
import { tierDisplayLabel } from '@/lib/signals/tier-labels';

/**
 * Turns the latest live signal into a concrete order ticket under the
 * composite's own rule. Pure: every input is passed in, nothing is fetched.
 *
 * Direction, stop and target come from calling the strategy's decideEntry on
 * a real StrategyContext, never from re-implementing its thresholds, so the
 * ticket cannot drift from the rule the evidence measured. The context carries
 * no indicator suite, snapshots or research columns: `score-threshold` reads
 * only the candles, the bar index, the score and the position, and
 * build.test.ts pins that read set, so a future strategy that needs more
 * fails there instead of silently reading nulls.
 */

export interface TradePlanSignal {
  score: number;
  tier: SignalTier;
  /** Open time of the scored bar, as stored on GlobalSignal. */
  candleTimestamp: number;
  configVersion: number;
  createdAt: string | Date;
}

export interface TradePlanInput {
  symbol: string;
  style: TradingStyle;
  interval: string;
  signal: TradePlanSignal;
  /** Closed bars in ascending order; must include the scored bar. Later bars are ignored. */
  candles: OHLCV[];
  /** Latest settled funding rate for the symbol, or null when none is stored. */
  fundingRate: number | null;
  equity?: number;
}

/** A plan cannot be built from the inputs given (for example the scored bar is missing). */
export class TradePlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TradePlanError';
  }
}

/** The context the strategy is called with. Fields score-threshold never reads are empty. */
export function signalContext(
  candles: OHLCV[],
  bar: number,
  interval: string,
  score: number,
  tier: SignalTier,
  position: OpenPosition | null
): StrategyContext {
  return {
    bar,
    candles,
    interval,
    suite: null,
    score,
    tier,
    superTrend: null,
    snapshot: null,
    snapshots: [],
    research: [],
    htfContext: null,
    session: null,
    position,
    pendingOrder: null,
  };
}

/** A stand-in position for asking the rule whether an open trade would close.
 * decideExit reads only the side and the score. */
function probePosition(side: TradeSide, price: number): OpenPosition {
  return {
    entryBar: 0,
    entryTime: 0,
    entryPrice: price,
    side,
    quantity: 0,
    entryScore: 0,
    entryTier: 'neutral',
    entrySession: null,
    stopPrice: price,
    targetPrice: null,
    timeStopBars: null,
    entrySlippageCost: 0,
  };
}

/**
 * The move over the recorded median hold, on the same window of bars the stop
 * is measured on. These candles are SPOT closes (fetchKlinesRange in
 * src/lib/binance.ts) while every cost here is a perp cost; the basis between
 * the two is small next to an hours-long move, and the Cost Check page
 * measures on perp bars.
 */
function holdMoveFor(history: OHLCV[], evidence: ControlEvidence): HoldMove | null {
  if (evidence.medianHoldBars === null) return null;
  const closes = history.slice(-(STOP_WINDOW_BARS + 1)).map((c) => c.close);
  const stats = holdMoveStats(closes, evidence.medianHoldBars);
  if (!stats) return null;
  return {
    holdBars: evidence.medianHoldBars,
    medianPercent: stats.medianPercent,
    meanPercent: stats.meanPercent,
    independentWindows: stats.independentWindows,
  };
}

function ticketCosts(
  side: TradeSide,
  config: BacktestConfig,
  stops: { stopPercent: number; targetPercent: number },
  interval: string,
  evidence: ControlEvidence,
  fundingRate: number | null,
  notional: number,
  history: OHLCV[]
): TicketCosts {
  const { stopPercent, targetPercent } = stops;
  const slippagePercent = (config.slippageBps ?? 0) / 100;
  const legPercent = (reason: 'stop_loss' | 'take_profit') =>
    feeRateFor(exitFillKind(reason), config) * 100 + (exitSlippageApplies(reason) ? slippagePercent : 0);

  const entryFeePercent = feeRateFor('taker', config) * 100;
  const entrySlippagePercent = slippagePercent;
  const stopExitPercent = legPercent('stop_loss');
  const targetExitPercent = legPercent('take_profit');
  const roundTripStopPercent = entryFeePercent + entrySlippagePercent + stopExitPercent;
  const roundTripTargetPercent = entryFeePercent + entrySlippagePercent + targetExitPercent;

  let expectedFundingCrossings: number | null = null;
  let fundingPercent: number | null = null;
  if (fundingRate !== null && evidence.medianHoldBars !== null) {
    expectedFundingCrossings = (evidence.medianHoldBars * intervalToMs(interval)) / FUNDING_INTERVAL_MS;
    // Binance convention: a positive rate means longs pay shorts.
    const paid = fundingRate * expectedFundingCrossings * 100;
    fundingPercent = side === 'long' ? paid : -paid;
  }

  const holdMove = holdMoveFor(history, evidence);

  return {
    entryFeePercent,
    entrySlippagePercent,
    stopExitPercent,
    targetExitPercent,
    roundTripStopPercent,
    roundTripTargetPercent,
    fundingPercent,
    fundingRate,
    expectedFundingCrossings,
    costShareOfRisk: stopPercent > 0 ? roundTripStopPercent / stopPercent : 0,
    roundTripStopUsdt: (notional * roundTripStopPercent) / 100,
    holdMove,
    costShareOfMove: holdMove && holdMove.meanPercent > 0 ? roundTripStopPercent / holdMove.meanPercent : null,
    bracketBreakeven: bracketBreakeven({
      stopPercent,
      targetPercent,
      lossCostPercent: roundTripStopPercent,
      winCostPercent: roundTripTargetPercent,
    }),
  };
}

export function buildTradePlan(input: TradePlanInput): TradePlan {
  const { symbol, style, interval, signal, fundingRate } = input;
  const equity = input.equity ?? DEFAULT_TICKET_EQUITY;

  const bar = input.candles.findIndex((c) => c.timestamp === signal.candleTimestamp);
  if (bar === -1) {
    throw new TradePlanError(
      `The scored ${interval} bar at ${new Date(signal.candleTimestamp).toISOString()} is not in the candle history`
    );
  }
  // Never hand the strategy a bar after the scored one.
  const history = input.candles.slice(0, bar + 1);

  const stops = stopsFor(history);
  const config = tradePlanConfig(style, interval, stops, equity);
  const evidence = evidenceFor(interval);
  const filter = venueFilterFor(symbol);
  const close = history[bar].close;

  const flat = signalContext(history, bar, interval, signal.score, signal.tier, null);
  const decision = TRADE_PLAN_STRATEGY.decideEntry(flat, config);

  const exitsFrom = (side: TradeSide) =>
    TRADE_PLAN_STRATEGY.decideExit(
      signalContext(history, bar, interval, signal.score, signal.tier, probePosition(side, close)),
      config
    );

  const notes: string[] = [];
  const rangesMeasured = Math.min(history.length - 1, STOP_WINDOW_BARS);
  if (rangesMeasured < STOP_WINDOW_BARS) {
    notes.push(
      `The stop is measured over ${rangesMeasured} true ranges, fewer than the ${STOP_WINDOW_BARS} the rule asks for.`
    );
  }

  let entry: TradeTicket | null = null;
  if (decision) {
    if (decision.targetPrice === null) {
      throw new TradePlanError('The score-threshold rule always sets a target; got none');
    }
    const side = decision.side;
    const modelEntryPrice = applySlippage(close, side === 'long' ? 'buy' : 'sell', config.slippageBps);
    const rawQuantity = computePositionSize(equity, modelEntryPrice, side, config, [], decision.stopPrice);
    const quantity = roundQty(rawQuantity, filter.stepSize);
    const notional = quantity * close;
    const stopPercent = stops.stopLossPercent * 100;
    const reason = placeability(quantity, close, filter);

    entry = {
      side,
      referencePrice: close,
      modelEntryPrice,
      stopPrice: roundPrice(decision.stopPrice, filter.tickSize),
      targetPrice: roundPrice(decision.targetPrice, filter.tickSize),
      stopPercent,
      targetPercent: stops.takeProfitPercent * 100,
      medianTrueRangePercent: stops.medianTrueRangePercent * 100,
      quantity,
      priceDecimals: decimalsOf(filter.tickSize),
      quantityDecimals: decimalsOf(filter.stepSize),
      notional,
      leverage: equity > 0 ? notional / equity : 0,
      riskAmount: quantity * Math.abs(modelEntryPrice - decision.stopPrice),
      placeable: reason === null,
      notPlaceableReason: reason,
      costs: ticketCosts(
        side,
        config,
        { stopPercent, targetPercent: stops.takeProfitPercent * 100 },
        interval,
        evidence,
        fundingRate,
        notional,
        history
      ),
    };

    const tierAgrees =
      (side === 'long' && (signal.tier === 'buy' || signal.tier === 'strong_buy')) ||
      (side === 'short' && (signal.tier === 'sell' || signal.tier === 'strong_sell'));
    if (!tierAgrees) {
      notes.push(
        `The rule enters at a score of ${config.entryThreshold} or beyond, while the "${tierDisplayLabel(signal.tier)}" label needs a score strictly beyond it.`
      );
    }
  }

  return {
    symbol,
    style,
    interval,
    signal: {
      score: signal.score,
      tier: signal.tier,
      candleTimestamp: signal.candleTimestamp,
      closeTime: signal.candleTimestamp + intervalToMs(interval),
      configVersion: signal.configVersion,
      createdAt: new Date(signal.createdAt).toISOString(),
    },
    rule: {
      entryThreshold: config.entryThreshold,
      exitThreshold: config.exitThreshold,
      shortEntryThreshold: config.shortEntryThreshold,
      shortExitThreshold: config.shortExitThreshold,
      stopWindowBars: STOP_WINDOW_BARS,
      riskPerTrade: RISK_PER_TRADE,
      equity,
    },
    entry,
    holding: { longExits: exitsFrom('long'), shortExits: exitsFrom('short') },
    evidence,
    notes,
  };
}
