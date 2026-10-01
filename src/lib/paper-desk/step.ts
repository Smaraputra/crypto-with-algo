import type { OHLCV } from '@/types/market';
import type { BacktestConfig, BacktestTrade, ExitReason, TradeSide } from '@/lib/backtest/types';
import {
  accrueFunding,
  checkStopTakeProfit,
  closeTrade,
  computeEquityAfterTrade,
  openPosition,
  type OpenPosition,
} from '@/lib/backtest/trade-utils';
import {
  applySlippage,
  exitFillKind,
  exitSlippageApplies,
  feeRateFor,
} from '@/lib/backtest/cost-model';
import { isSessionMeaningful } from '@/lib/sessions';
import { intervalToMs } from '@/lib/intervals';
import { TRADE_PLAN_STRATEGY } from '@/lib/trade-plan/rule';
import { signalContext } from '@/lib/trade-plan/build';
import type {
  DeskPosition,
  DeskTrade,
  ExecutableFill,
  FundingCharge,
  LedgerState,
  SkipReason,
  StepInput,
  StepOutcome,
} from './types';

/**
 * One bar of one (book, symbol) ledger, as a pure function.
 *
 * The per-bar order is `src/lib/backtest/bar-loop.ts`'s, step for step, so the
 * engine track is comparable with every recorded research number. The one
 * engine step the desk leaves out is bar-loop's step 1, the optional
 * `strategy.manage` hook: it runs only for a strategy that defines `manage`,
 * and `TRADE_PLAN_STRATEGY` does not (`step.test.ts` pins that). A strategy
 * that gains a `manage` hook must not be stepped here until the desk grows the
 * same step, or the parity with the engine silently breaks.
 *
 *  1. Price and bar exits for a position open at the top of the bar: the stop
 *     before the target (`checkStopTakeProfit`), then the time stop. Funding is
 *     accrued at the exit site, and equity updates immediately, so a same-bar
 *     re-entry is sized on the post-exit equity.
 *  2. The score exit, at this bar's close, with `exitScore` set to the score.
 *     A position closed this way gets NO same-bar re-entry, matching the
 *     engine's `if (position) ... else ...` structure.
 *  3. Otherwise, when flat, a fresh entry: a market fill at the bar's close
 *     after slippage, with `rawPrice` the unslipped close.
 *  4. Funding for a position that survives to the close. `accrueFunding`
 *     no-ops on the entry bar, so a position opened in step 3 is never charged
 *     here, and a position closed earlier this bar was already accrued.
 *
 * `end_of_data` has no counterpart: a live desk has no last bar. A position
 * still open simply stays open.
 *
 * Deliberate differences from the engine, each one a live constraint rather
 * than a choice:
 *
 * - **A missing score is not a decision.** `compute-signals` writes a row only
 *   for the latest closed bar of each run (`compute-engine.ts:305-319`), so a
 *   missed run leaves a permanent hole. On such a bar the desk runs step 1 and
 *   step 4 and skips steps 2 and 3: price exits still happen, but nothing
 *   opens or closes on a score that was never computed.
 * - **The executable track.** The engine fills a market entry at the decision
 *   bar's own close, which is lag 0 and, as `scripts/research/factor-ic.ts:228-245`
 *   records, optimistic for a close-derived signal. No live order can do that.
 *   Every trade therefore also carries the price a live order would have got:
 *   the open of the first bar at or after the signal was written, a stop that
 *   gapped filled at the bar's open rather than at the stop price, and the same
 *   quantity as the engine so the two tracks hold the same position and differ
 *   only in price.
 */

/** Reconstructs a bar index from a timestamp on a contiguous interval grid. */
export function barOfTimestamp(timestamp: number, bar: number, candle: OHLCV, intervalMs: number): number {
  return bar - Math.round((candle.timestamp - timestamp) / intervalMs);
}

/**
 * The executable entry fill for a position whose entry bar has passed.
 *
 * The decision bar N closes at the moment bar N+1 opens, and
 * `compute-signals` writes the row seconds later, so the order is placed a
 * little way into bar N+1. The fill is therefore bar N+1's open: the standard
 * next-open convention, and the closest price daily OHLC can offer.
 *
 * The seconds of drift between that open and the moment the order was actually
 * placed are not modelled, because bar data cannot see inside a bar. The
 * alternative, waiting for the first bar that OPENS after the row was written,
 * would always land on bar N+2 and charge a full extra bar of drift a real
 * trader never pays, which would overstate the lag rather than measure it.
 *
 * A genuinely late score still slips a bar: the fill is the first bar whose
 * own close is at or after the row was written, so at 1m a score that takes
 * two minutes to appear fills two bars out.
 */
function executableEntry(
  candles: OHLCV[],
  position: DeskPosition,
  intervalMs: number
): { price: number; bar: number } | null {
  if (position.executableEntryPrice !== null && position.executableEntryBar !== null) {
    return { price: position.executableEntryPrice, bar: position.executableEntryBar };
  }
  const entryBar = position.engine.entryBar;
  for (let i = Math.max(entryBar + 1, 0); i < candles.length; i++) {
    if (candles[i].timestamp + intervalMs >= position.signalCreatedAt) {
      return { price: candles[i].open, bar: i };
    }
  }
  return null;
}

/**
 * The executable track's version of a trade the engine has just closed.
 *
 * It keeps the engine's quantity, side and exit reason, and changes only the
 * two prices: the entry fills at the first live-reachable open, and a stop
 * that price had already passed at that bar's open fills at the open.
 */
export function executableFill(
  engine: BacktestTrade,
  entry: { price: number; bar: number } | null,
  exitCandle: OHLCV,
  stopPrice: number,
  /**
   * The exit price BEFORE slippage. `engine.exitPrice` has already had it
   * applied by `closeTrade`, so re-slipping that would charge the exit twice.
   */
  rawExitPrice: number,
  fundingCost: number,
  config: BacktestConfig
): ExecutableFill {
  const empty: ExecutableFill = {
    filled: false,
    entryPrice: 0,
    exitPrice: 0,
    entryDelayBars: 0,
    gappedStop: false,
    stoppedOnArrival: false,
    fees: 0,
    slippageCost: 0,
    pnl: 0,
    pnlPercent: 0,
  };
  if (!entry) return empty;

  const side: TradeSide = engine.side;
  const quantity = engine.quantity;
  const buying = side === 'long';

  // Entry: a market order crossing the book at that open.
  const rawEntry = entry.price;
  const entryPrice = applySlippage(rawEntry, buying ? 'buy' : 'sell', config.slippageBps);
  const entrySlippage = Math.abs(entryPrice - rawEntry) * quantity;

  // Was price already through the stop when the order filled?
  const stoppedOnArrival = buying ? entryPrice <= stopPrice : entryPrice >= stopPrice;

  let exitReason: ExitReason = engine.exitReason;
  let rawExit = rawExitPrice;
  let gappedStop = false;

  if (stoppedOnArrival) {
    // The position is stopped the moment it opens; book it at the fill price.
    exitReason = 'stop_loss';
    rawExit = entryPrice;
  } else if (engine.exitReason === 'stop_loss') {
    // A stop fills at its price only if the bar did not open beyond it.
    const openBeyond = buying ? exitCandle.open <= stopPrice : exitCandle.open >= stopPrice;
    if (openBeyond) {
      gappedStop = true;
      rawExit = exitCandle.open;
    } else {
      rawExit = stopPrice;
    }
  }

  const exitKind = exitFillKind(exitReason);
  const effectiveExit = exitSlippageApplies(exitReason)
    ? applySlippage(rawExit, buying ? 'sell' : 'buy', config.slippageBps)
    : rawExit;
  const exitSlippage = Math.abs(effectiveExit - rawExit) * quantity;

  const entryNotional = quantity * entryPrice;
  const fees =
    entryNotional * feeRateFor('taker', config) + quantity * effectiveExit * feeRateFor(exitKind, config);

  const gross = buying
    ? (effectiveExit - entryPrice) * quantity
    : (entryPrice - effectiveExit) * quantity;
  // Funding is a property of the position's size and time held, which both
  // tracks share, so the engine's figure carries over unchanged.
  const pnl = gross - fees - fundingCost;

  return {
    filled: true,
    entryPrice,
    exitPrice: effectiveExit,
    entryDelayBars: entry.bar - engine.entryBar,
    gappedStop,
    stoppedOnArrival,
    fees,
    slippageCost: entrySlippage + exitSlippage,
    pnl,
    pnlPercent: entryNotional > 0 ? (pnl / entryNotional) * 100 : 0,
  };
}

export function emptyLedger(startEquity: number): LedgerState {
  return { equity: startEquity, executableEquity: startEquity, position: null };
}

export function stepLedger(state: LedgerState, input: StepInput): StepOutcome {
  const { candles, bar, interval, decision, fundingRate, config } = input;
  const candle = candles[bar];
  const intervalMs = intervalToMs(interval);
  const sessionMeaningful = isSessionMeaningful(interval);
  const sessionFilter =
    sessionMeaningful && config.allowedSessions && config.allowedSessions.length > 0
      ? new Set(config.allowedSessions)
      : null;

  let equity = state.equity;
  let executableEquity = state.executableEquity;
  let position: DeskPosition | null = state.position;
  const closed: DeskTrade[] = [];
  let skipped: SkipReason | null = null;
  let funding: FundingCharge | null = null;

  /** Accrues funding for a bar the position stayed open through, as bar-loop.ts does. */
  const accrueThisBar = (pos: OpenPosition) => {
    if (!config.fundingEnabled || bar <= pos.entryBar) return;
    if (typeof fundingRate !== 'number') return;
    const before = pos.fundingPnl ?? 0;
    accrueFunding(pos, candle, candles[bar - 1].timestamp + intervalMs, candle.timestamp + intervalMs, fundingRate);
    const delta = (pos.fundingPnl ?? 0) - before;
    // A bar that crosses no settlement accrues nothing; only record real charges.
    if (delta !== 0) {
      funding = { time: candle.timestamp + intervalMs, rate: fundingRate, amount: -delta };
    }
  };

  /** Closes the engine position and books both tracks. */
  const close = (pos: DeskPosition, exitPrice: number, reason: ExitReason, exitScore: number) => {
    accrueThisBar(pos.engine);
    const entry = executableEntry(candles, pos, intervalMs);
    const stopPrice = pos.engine.stopPrice;
    const trades: BacktestTrade[] = [];
    closeTrade(pos.engine, exitPrice, bar, candle.timestamp, reason, exitScore, trades, config);
    const engineTrade = trades[0];
    equity = computeEquityAfterTrade(equity, engineTrade);
    const executable = executableFill(
      engineTrade,
      entry,
      candle,
      stopPrice,
      exitPrice,
      engineTrade.fundingCost,
      config
    );
    if (executable.filled) executableEquity += executable.pnl;
    closed.push({ engine: engineTrade, executable });
    position = null;
  };

  // 1. Price and bar exits, stop before target.
  if (position) {
    const { exitReason, exitPrice } = checkStopTakeProfit(position.engine, candle);
    if (exitReason) {
      close(position, exitPrice, exitReason, 0);
    } else if (
      position.engine.timeStopBars !== null &&
      bar - position.engine.entryBar >= position.engine.timeStopBars
    ) {
      close(position, candle.close, 'time_stop', 0);
    }
  }

  // A bar the scorer never covered carries no decision: manage only.
  if (!decision.scored) {
    if (position) {
      // Fill the executable entry as soon as its bar exists, even on an unscored bar.
      const entry = executableEntry(candles, position, intervalMs);
      if (entry && entry.bar <= bar) {
        position.executableEntryPrice = entry.price;
        position.executableEntryBar = entry.bar;
      }
      accrueThisBar(position.engine);
    }
    return { state: { equity, executableEquity, position }, closed, skipped: 'missing_score', funding };
  }

  // 2. The score exit, at this bar's close.
  if (position) {
    const ctx = signalContext(candles, bar, interval, decision.score, decision.tier, position.engine);
    if (TRADE_PLAN_STRATEGY.decideExit(ctx, config)) {
      close(position, candle.close, 'signal', decision.score);
    }
  } else {
    // 3. Flat: a fresh entry, gated by the session filter exactly as the engine gates it.
    const sessionAllowed = !sessionFilter || (decision.session !== null && sessionFilter.has(decision.session));
    if (!sessionAllowed) {
      skipped = 'session_filtered';
    } else {
      const ctx = signalContext(candles, bar, interval, decision.score, decision.tier, null);
      const entryDecision = TRADE_PLAN_STRATEGY.decideEntry(ctx, config);
      if (entryDecision) {
        const entryPrice = applySlippage(
          candle.close,
          entryDecision.side === 'long' ? 'buy' : 'sell',
          config.slippageBps
        );
        const engine = openPosition(
          entryDecision,
          { price: entryPrice, rawPrice: candle.close, bar, time: candle.timestamp, kind: 'taker' },
          equity,
          config,
          [],
          decision.score,
          decision.tier,
          decision.session
        );
        position = {
          engine,
          executableEntryPrice: null,
          executableEntryBar: null,
          signalCreatedAt: decision.signalCreatedAt ?? candle.timestamp + intervalMs,
        };
      }
    }
  }

  // 4. Funding for a position that survives to the close, and the executable fill once reachable.
  if (position) {
    const entry = executableEntry(candles, position, intervalMs);
    if (entry && entry.bar <= bar) {
      position.executableEntryPrice = entry.price;
      position.executableEntryBar = entry.bar;
    }
    accrueThisBar(position.engine);
  }

  return { state: { equity, executableEquity, position }, closed, skipped, funding };
}
