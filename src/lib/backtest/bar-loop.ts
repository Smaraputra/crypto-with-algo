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
import type { EntryDecision, ManagementContext, ManagementDecision, Strategy, StrategyContext } from './strategy';
import type { SnapshotBar } from './snapshot-series';
import type { ResearchBar } from './research-series';
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
  /** Research-only per-bar columns; see research-series.ts. Absent for
   * every live and UI backtest, which is why it defaults to []. */
  research?: (ResearchBar | null)[];
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
 * - A limit fill happens mid-bar, so the same candle's stop and target are
 *   checked immediately against the freshly opened position (fill first,
 *   then stop/target, the conservative order): a bar that gaps through the
 *   limit and then also runs through the stop closes as a stop_loss on that
 *   same bar instead of leaking the loss into the next one.
 * - An optional strategy.manage hook runs once per bar, before this bar's
 *   price/bar-based exit checks, for a position opened on an EARLIER bar
 *   (never the entry bar itself, mirroring accrueFundingThisBar). It is
 *   handed a `ManagementContext` that is one bar BEHIND the engine's current
 *   bar (`bar - 1`, with `suite`/`score`/`tier` cached from that earlier
 *   bar's own once-per-bar computation, never recomputed) plus this bar's own
 *   OPEN passed separately -- never this bar's high, low, or close, and never
 *   this bar's own suite/score, which do not exist yet at the decision point.
 *   A returned stopPrice is applied only when it sits on the correct side of
 *   this bar's OPEN (long: below; short: above); a returned non-null
 *   targetPrice the same way (long: above; short: below). Either rejection is
 *   ignored for this bar and counted in managementRejected. A returned
 *   targetPrice of `null` (removing the target) is always applied. Because
 *   this runs before checkStopTakeProfit, a tightened stop can close the
 *   position on the same bar it was tightened on -- but only via information
 *   that bar's own open already made causal, never via that bar's own range.
 *   See `Strategy.manage`'s and `ManagementContext`'s own headers
 *   (strategy.ts) for why the context is shaped this way. Absent entirely for
 *   a strategy with no manage hook, so the default path never runs this step
 *   and its output is unaffected.
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
    research,
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
  let managementRejected = 0;

  // Cached one bar behind the loop's current `bar`, for a manage hook's
  // ManagementContext (see applyManagement and the same-bar semantics note
  // above). Updated at the bottom of each iteration, AFTER that iteration's
  // own suite/score have been used for everything that legitimately reads
  // the current bar (checkStopTakeProfit, decideExit, decideEntry), so a
  // manage call earlier in the SAME iteration still sees last bar's values.
  // Never read before a position exists (manage is only ever called once
  // `bar > position.entryBar`, and by then at least one prior iteration --
  // the entry bar's own -- has already run and set these), so the initial
  // values below are never actually consumed.
  let prevSuite: IndicatorSuite | null = null;
  let prevScore = 0;
  let prevTier: SignalTier = 'neutral';

  /** Accrues funding for `pos` through `atCandle`'s own crossings, whether
   * `atCandle` is the bar the position survives to, or the bar it exits on.
   * No-ops on the entry bar itself (bar === entryBar), when funding is
   * disabled, or when no funding rate is available for this bar. Shared by
   * every close site so an exit bar's crossing is never silently dropped. */
  function accrueFundingThisBar(
    pos: OpenPosition,
    atBar: number,
    atCandle: OHLCV,
    atSnap: SnapshotBar | null
  ): void {
    if (!config.fundingEnabled || atBar <= pos.entryBar) return;
    const rate = atSnap?.futures?.fundingRate?.fundingRate;
    if (typeof rate !== 'number') return;
    accrueFunding(
      pos,
      atCandle,
      candles[atBar - 1].timestamp + intervalMs,
      atCandle.timestamp + intervalMs,
      rate
    );
  }

  /** Runs a strategy's optional manage hook for `pos`, opened on an earlier
   * bar, and applies its decision before this bar's checkStopTakeProfit
   * runs. `ctx` is one bar behind the engine's current bar by construction
   * (see ManagementContext's header, strategy.ts); `currentOpen` is that
   * current bar's own OPEN, the only current-bar value the engine passes in
   * at all, checked here rather than exposed on `ctx` so `manage` has no
   * current-bar candle to read past its open. A returned stopPrice is
   * accepted only when it sits on the correct side of `currentOpen` (long:
   * below; short: above); a returned non-null targetPrice the same way
   * (long: above; short: below). Either rejection is counted in
   * `managementRejected` and otherwise ignored for this bar. A returned
   * targetPrice of `null` (removing the target) is always applied, since
   * removing a target can never produce a same-bar fill the position could
   * not otherwise have had. `managed` is set only when a returned price is
   * both accepted and actually different from the position's current one,
   * so a hook that returns its own no-op decision does not mark a trade
   * managed. Caller only invokes this when the strategy has a manage hook
   * and `pos` was not opened this bar (mirrors accrueFundingThisBar's own
   * entry-bar skip). */
  function applyManagement(
    manage: NonNullable<Strategy['manage']>,
    ctx: ManagementContext,
    pos: OpenPosition,
    currentOpen: number
  ): void {
    const decision: ManagementDecision | null = manage(ctx, pos);
    if (!decision) return;

    if (decision.stopPrice !== undefined) {
      const onCorrectSide = pos.side === 'long' ? decision.stopPrice < currentOpen : decision.stopPrice > currentOpen;
      if (onCorrectSide) {
        if (decision.stopPrice !== pos.stopPrice) {
          pos.stopPrice = decision.stopPrice;
          pos.managed = true;
        }
      } else {
        managementRejected++;
      }
    }

    if (decision.targetPrice !== undefined) {
      const onCorrectSide =
        decision.targetPrice === null ||
        (pos.side === 'long' ? decision.targetPrice > currentOpen : decision.targetPrice < currentOpen);
      if (onCorrectSide) {
        if (decision.targetPrice !== pos.targetPrice) {
          pos.targetPrice = decision.targetPrice;
          pos.managed = true;
        }
      } else {
        managementRejected++;
      }
    }
  }

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

    // 1. Position management hook, for a position opened on an earlier bar,
    // applied before this bar's price/bar-based exit checks so a tightened
    // stop or a removed target take effect on the same bar (see
    // applyManagement's own header and the same-bar semantics note above).
    // Uses ONLY `prevSuite`/`prevScore`/`prevTier` (cached at the bottom of
    // the previous iteration, i.e. as of `bar - 1`) and this bar's own OPEN
    // -- never this bar's own suite/score, which are not computed until
    // step 3 below, and never this bar's high/low/close.
    if (position && strategy.manage && bar > position.entryBar) {
      const manageCtx: ManagementContext = {
        bar: bar - 1,
        candles,
        interval,
        suite: prevSuite,
        score: prevScore,
        tier: prevTier,
      };
      applyManagement(strategy.manage, manageCtx, position, candle.open);
    }

    // 2. Price/bar-based exit checks for a position open at the top of this bar
    if (position) {
      const { exitReason, exitPrice } = checkStopTakeProfit(position, candle);
      if (exitReason) {
        accrueFundingThisBar(position, bar, candle, snap);
        closeTrade(position, exitPrice, bar, candle.timestamp, exitReason, 0, trades, config);
        equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);
        position = null;
      } else if (
        position.timeStopBars !== null &&
        bar - position.entryBar >= position.timeStopBars
      ) {
        accrueFundingThisBar(position, bar, candle, snap);
        closeTrade(position, candle.close, bar, candle.timestamp, 'time_stop', 0, trades, config);
        equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);
        position = null;
      }
    }

    // 3. Interpret indicators and score once per bar, regardless of state
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

    // 4. Strategy-level exit, pending-order fill/cancel, or a fresh entry
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
        snapshots: snapshots ?? [],
        research: research ?? [],
        htfContext: htfCtx,
        session,
        position,
        pendingOrder: null,
      };
      if (strategy.decideExit(ctx, config)) {
        accrueFundingThisBar(position, bar, candle, snap);
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
          {
            price: outcome.fillPrice,
            rawPrice: outcome.fillPrice, // a limit fill never slips
            bar: outcome.fillBar,
            time: candle.timestamp,
            kind: 'maker',
          },
          equity,
          config,
          trades,
          pending.score,
          pending.tier,
          pending.session
        );
        pending = null;

        // The fill happens mid-bar: check this same candle's stop and target
        // against the position that was just opened (fill first, then
        // stop/target), so a bar that gaps through the limit and then runs
        // through the stop books the loss on this bar, not the next one.
        const fillBarExit = checkStopTakeProfit(position, candle);
        if (fillBarExit.exitReason) {
          accrueFundingThisBar(position, bar, candle, snap);
          closeTrade(
            position,
            fillBarExit.exitPrice,
            bar,
            candle.timestamp,
            fillBarExit.exitReason,
            0,
            trades,
            config
          );
          equity = computeEquityAfterTrade(equity, trades[trades.length - 1]);
          position = null;
        }
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
          snapshots: snapshots ?? [],
          research: research ?? [],
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
              { price: entryPrice, rawPrice: candle.close, bar, time: candle.timestamp, kind: 'taker' },
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

    // 5. Funding accrual for a position that survives to this bar's close.
    // A position that exited earlier this bar was already accrued at its
    // own close site above and is null here, so this never double-charges.
    if (position) {
      accrueFundingThisBar(position, bar, candle, snap);
    }

    // 6. Equity curve point
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    equityCurve.push({ bar, time: candle.timestamp, equity, drawdown });

    // 7. Progress
    if (onProgress) {
      const barsProcessed = bar - warmupBars + 1;
      const progress = Math.round((barsProcessed / totalBars) * 100);
      onProgress(progress, barsProcessed, totalBars);
    }

    // Cache this bar's suite/score/tier as "previous" for step 1's manage
    // call on the NEXT bar. Done last so nothing else in this iteration
    // (all of which legitimately reads the CURRENT bar) is affected by the
    // order of this assignment.
    prevSuite = suite;
    prevScore = composite.score;
    prevTier = composite.tier;
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
    ...(strategy.manage ? { managementRejected } : {}),
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
