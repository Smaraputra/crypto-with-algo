import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { SuperTrendPoint, SuperTrendResult } from '@/lib/indicators/supertrend';
import type { HtfContext, SignalTier } from '@/types/signal';
import type { MarketSession } from '@/lib/sessions';
import { computeSignalScore } from '@/lib/signals/scorer';
import { computeMetrics } from './metrics';
import { isSessionMeaningful, sessionOfCandleClose } from '@/lib/sessions';
import { intervalToMs } from '@/lib/intervals';
import { applySlippage } from './cost-model';
import { evaluateLimitOrder, type PendingOrder } from './limit-orders';
import {
  accrueFunding,
  checkStopTakeProfit,
  closeTrade,
  computeEquityAfterTrade,
  openPosition,
  type OpenPosition,
} from './trade-utils';
import type { EntryDecision, Strategy, StrategyContext } from './strategy';
import type { SnapshotBar } from './snapshot-series';
import type {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  EquityPoint,
  BacktestProgressCallback,
  SnapshotCoverage,
} from './types';

/**
 * HTF alignment and per-HTF-bar context, in the shape the bar loop needs.
 * Structurally matches `PreparedBacktest['htf']` (optimized-engine.ts) and
 * engine.ts's own `prepareHtf()` output; defined locally so this module has
 * no dependency on either engine file.
 */
export interface BarLoopHtf {
  contextAtHtfBar: (HtfContext | null)[];
  ltfToHtf: Int32Array;
}

export interface BarLoopInput {
  candles: OHLCV[];
  config: BacktestConfig;
  symbol: string;
  interval: string;
  warmupBars: number;
  /** Interpreted indicator suite at a bar. engine.ts computes this on the
   * fly; optimized-engine.ts indexes a precomputed array. Either way the
   * loop calls it exactly once per bar, in ascending order, as the engines
   * did before this file existed (tests mock computeSignalScore by call
   * order and depend on this). */
  suiteAtBar: (bar: number) => IndicatorSuite;
  superTrend: SuperTrendPoint[];
  stOffset: number;
  htf?: BarLoopHtf;
  snapshots?: (SnapshotBar | null)[];
  strategy: Strategy;
  onProgress?: BacktestProgressCallback;
}

/** A limit order together with the decision that produced it, kept as one
 * unit so a fill or cancel never risks acting on a stale stop/target/score
 * from a different pending order. */
interface PendingLimit {
  order: PendingOrder;
  decision: EntryDecision;
  score: number;
  tier: SignalTier;
  session: MarketSession | null;
}

/**
 * Per-bar state machine shared by both engines: price/bar-based exits (stop,
 * target, time stop), a strategy's decideExit, pending limit-order
 * evaluation, and decideEntry, in that priority order every bar.
 *
 * Same-bar semantics (must hold for the default score-threshold strategy to
 * keep the golden regression fixture byte-identical):
 * - A position closed by a PRICE/BAR-based reason this bar (stop_loss,
 *   take_profit, time_stop) frees the bar for a same-bar check of whatever
 *   is next: an existing pending order's fill/cancel, or (if truly flat) a
 *   fresh decideEntry call. This matches the pre-Strategy engines, which
 *   computed the composite score once per bar and fell through to the entry
 *   branch whenever the position had just been nulled by the stop/target
 *   check, and extends the same treatment to time_stop.
 * - A position closed by the strategy's decideExit ('signal') does NOT get
 *   a same-bar re-entry check: the bar's decision is consumed by the exit,
 *   exactly as the old `if (position) {...} else {...}` structure allowed
 *   only one branch to run once position was known non-null at that point.
 * - A pending limit order that fills or is cancelled this bar does not get
 *   a same-bar fresh decideEntry call either; the next bar is the earliest
 *   a new entry can be considered.
 */
export function runBarLoop(input: BarLoopInput): BacktestResult {
  const {
    candles,
    config,
    symbol,
    interval,
    warmupBars,
    suiteAtBar,
    superTrend,
    stOffset,
    htf,
    snapshots,
    strategy,
    onProgress,
  } = input;

  const totalBars = candles.length - warmupBars;
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  const sessionMeaningful = isSessionMeaningful(interval);
  const intervalMs = intervalToMs(interval);
  const sessionFilter =
    sessionMeaningful && config.allowedSessions && config.allowedSessions.length > 0
      ? new Set(config.allowedSessions)
      : null;

  let equity = config.startEquity;
  let peakEquity = equity;
  let position: OpenPosition | null = null;
  let pending: PendingLimit | null = null;
  let barsWithFutures = 0;
  let barsWithSentiment = 0;

  for (let bar = warmupBars; bar < candles.length; bar++) {
    const candle = candles[bar];
    const snap = snapshots?.[bar] ?? null;
    if (snap?.futures) barsWithFutures++;
    if (snap?.sentiment) barsWithSentiment++;

    const stIdx = bar - stOffset;
    const superTrendAtBar: SuperTrendPoint | undefined =
      stIdx >= 0 && stIdx < superTrend.length ? superTrend[stIdx] : undefined;
    const superTrendResult: SuperTrendResult | null = superTrendAtBar
      ? { values: superTrend, current: superTrendAtBar }
      : null;

    const htfBar = htf ? htf.ltfToHtf[bar] : -1;
    const htfCtx = htf && htfBar >= 0 ? htf.contextAtHtfBar[htfBar] : null;

    // 1. Price/bar-based exit checks for a position open at the top of this bar
    if (position) {
      const { exitReason, exitPrice } = checkStopTakeProfit(position, candle);
      if (exitReason) {
        closeTrade(position, exitPrice, bar, candle.timestamp, exitReason, 0, trades, config);
        equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);
        position = null;
      } else if (
        position.timeStopBars !== null &&
        bar - position.entryBar >= position.timeStopBars
      ) {
        closeTrade(position, candle.close, bar, candle.timestamp, 'time_stop', 0, trades, config);
        equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);
        position = null;
      }
    }

    // 2. Interpret indicators and score once per bar, regardless of state
    const suite = suiteAtBar(bar);
    const composite = computeSignalScore(
      suite,
      snap?.futures ?? null,
      snap?.sentiment ?? null,
      config.weights,
      superTrendResult,
      htfCtx
    );
    const session = sessionMeaningful ? sessionOfCandleClose(candle.timestamp, intervalMs) : null;

    // 3. Strategy-level exit, pending-order fill/cancel, or a fresh entry
    if (position) {
      // Survived the price/bar-based checks above: only a strategy exit can close it now
      const ctx: StrategyContext = {
        bar,
        candles,
        interval,
        suite,
        score: composite.score,
        tier: composite.tier,
        superTrend: superTrendResult,
        snapshot: snap,
        htfContext: htfCtx,
        session,
        position,
        pendingOrder: null,
      };
      if (strategy.decideExit(ctx, config)) {
        closeTrade(
          position,
          candle.close,
          bar,
          candle.timestamp,
          'signal',
          composite.score,
          trades,
          config
        );
        equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);
        position = null;
      }
    } else if (pending) {
      const outcome = evaluateLimitOrder(pending.order, bar, candle);
      if (outcome.status === 'filled') {
        position = openPosition(
          pending.decision,
          { price: outcome.fillPrice, bar: outcome.fillBar, time: candle.timestamp, kind: 'maker' },
          equity,
          config,
          trades,
          pending.score,
          pending.tier,
          pending.session
        );
        pending = null;
      } else if (outcome.status === 'cancelled') {
        pending = null;
      }
      // pending: leave state untouched, evaluate again next bar
    } else {
      // Flat with no pending order; the session filter gates entries only, never exits
      const sessionAllowed = !sessionFilter || (session !== null && sessionFilter.has(session));
      if (sessionAllowed) {
        const ctx: StrategyContext = {
          bar,
          candles,
          interval,
          suite,
          score: composite.score,
          tier: composite.tier,
          superTrend: superTrendResult,
          snapshot: snap,
          htfContext: htfCtx,
          session,
          position: null,
          pendingOrder: null,
        };
        const decision = strategy.decideEntry(ctx, config);
        if (decision) {
          if (decision.orderType === 'market') {
            const entryPrice = applySlippage(
              candle.close,
              decision.side === 'long' ? 'buy' : 'sell',
              config.slippageBps
            );
            position = openPosition(
              decision,
              { price: entryPrice, bar, time: candle.timestamp, kind: 'taker' },
              equity,
              config,
              trades,
              composite.score,
              composite.tier,
              session
            );
          } else {
            pending = {
              order: {
                side: decision.side,
                limitPrice: decision.limitPrice as number,
                placedBar: bar,
                timeoutBars: decision.timeoutBars ?? config.limitTimeoutBars ?? 3,
              },
              decision,
              score: composite.score,
              tier: composite.tier,
              session,
            };
          }
        }
      }
    }

    // 4. Funding accrual for a position that survives to this bar's close
    if (config.fundingEnabled && position && bar > position.entryBar) {
      const rate = snap?.futures?.fundingRate?.fundingRate;
      if (typeof rate === 'number') {
        accrueFunding(
          position,
          candle,
          candles[bar - 1].timestamp + intervalMs,
          candle.timestamp + intervalMs,
          rate
        );
      }
    }

    // 5. Equity curve point
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    equityCurve.push({ bar, time: candle.timestamp, equity, drawdown });

    // 6. Progress
    if (onProgress) {
      const barsProcessed = bar - warmupBars + 1;
      const progress = Math.round((barsProcessed / totalBars) * 100);
      onProgress(progress, barsProcessed, totalBars);
    }
  }

  // End of data: close an open position at the close; discard a pending order
  if (position) {
    const lastCandle = candles[candles.length - 1];
    closeTrade(
      position,
      lastCandle.close,
      candles.length - 1,
      lastCandle.timestamp,
      'end_of_data',
      0,
      trades,
      config
    );
    equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);

    if (equityCurve.length > 0) {
      equityCurve[equityCurve.length - 1].equity = equity;
    }
  }

  const metrics = computeMetrics(trades, equityCurve, config.startEquity, interval);

  return {
    symbol,
    interval,
    config,
    trades,
    equityCurve,
    metrics,
    startTime: candles[warmupBars]?.timestamp ?? candles[0].timestamp,
    endTime: candles[candles.length - 1].timestamp,
    totalBars,
    warmupBars,
    ...(snapshots
      ? { snapshotCoverage: computeSnapshotCoverage(barsWithFutures, barsWithSentiment, totalBars) }
      : {}),
  };
}

export function computeSnapshotCoverage(
  barsWithFutures: number,
  barsWithSentiment: number,
  scoredBars: number
): SnapshotCoverage {
  return {
    barsWithFutures,
    barsWithSentiment,
    scoredBars,
    futuresPercent: scoredBars > 0 ? Math.round((barsWithFutures / scoredBars) * 100) : 0,
    sentimentPercent: scoredBars > 0 ? Math.round((barsWithSentiment / scoredBars) * 100) : 0,
  };
}
