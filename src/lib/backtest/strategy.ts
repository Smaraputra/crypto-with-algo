import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { SuperTrendResult } from '@/lib/indicators/supertrend';
import type { HtfContext, SignalTier } from '@/types/signal';
import type { MarketSession } from '@/lib/sessions';
import type { OpenPosition } from './trade-utils';
import type { PendingOrder } from './limit-orders';
import type { SnapshotBar } from './snapshot-series';
import type { ResearchBar } from './research-series';
import type { BacktestConfig, TradeSide } from './types';

/**
 * Everything a strategy can read at one bar. Strategies must only read
 * indices <= bar off `candles`; the engine is responsible for not handing
 * out future bars.
 */
export interface StrategyContext {
  bar: number;
  candles: OHLCV[];
  interval: string;
  suite: IndicatorSuite | null; // interpreted signals at bar, null before warmup
  score: number; // composite score at bar as the engine computes it today
  tier: SignalTier;
  superTrend: SuperTrendResult | null; // the type the engines already pass to computeSignalScore
  snapshot: SnapshotBar | null; // per-bar futures and sentiment inputs
  /**
   * The whole aligned snapshot series, index-matched to `candles`.
   *
   * Same causality contract as `candles`: a strategy may read indices up to
   * and including `bar` and must never look past it. It exists because the
   * Phase 3b factor study measured the long/short ratio by Spearman rank
   * within each symbol, not by absolute level, and the level's distribution
   * differs far too much between symbols for a fixed threshold to mean the
   * same thing (4h p95 runs from 1.76 on BNBUSDT to 4.54 on DOGEUSDT). A rule
   * that tests what was measured therefore needs a trailing window of the
   * series, not just the current reading.
   */
  snapshots: (SnapshotBar | null)[];
  /**
   * Research-only per-bar numeric columns, index-matched to `candles`.
   *
   * Same causality contract as `candles` and `snapshots`: read indices up to
   * and including `bar`, never past it.
   *
   * Prefer this over deriving a trailing window from `ctx.snapshots`. The
   * walk-forward prepares each window from a SLICE of the candle array, so a
   * window derived in-strategy is full in-sample and truncated out-of-sample,
   * and the same grid cell then means two different things on the two sides of
   * the split. Columns here are computed once over the full series by the
   * harness and merely sliced, so they do not have that problem. See the
   * header of research-series.ts for the measured impact on Phase 4b.
   *
   * Empty for every live and UI backtest; only the research harness fills it.
   * Nothing here ever reaches `computeSignalScore`.
   */
  research: (ResearchBar | null)[];
  htfContext: HtfContext | null;
  session: MarketSession | null;
  position: OpenPosition | null;
  pendingOrder: PendingOrder | null;
}

export interface EntryDecision {
  side: TradeSide;
  orderType: 'market' | 'limit';
  limitPrice?: number; // required for limit
  timeoutBars?: number; // limit only; the engine falls back to config.limitTimeoutBars
  stopPrice: number; // absolute price
  targetPrice: number | null; // absolute price or null for no target
  timeStopBars?: number | null;
}

/**
 * A per-bar adjustment to an open position's stop and/or target, returned by
 * a strategy's optional `manage` hook. Either field may be omitted to leave
 * that price unchanged this bar; `targetPrice` may be `null` to remove the
 * target outright. The engine (bar-loop.ts) is the only place that applies
 * this: it rejects a `stopPrice` that lands on the wrong side of the bar's
 * open (long: not below it, short: not above it), and a non-null
 * `targetPrice` on the wrong side the same way (long: not above it, short:
 * not below it), rather than trust the strategy, since accepting either
 * would let a position get stopped out, or take-profited, by its own
 * management on a bar it could never have exited on that side.
 */
export interface ManagementDecision {
  stopPrice?: number;
  targetPrice?: number | null;
}

/**
 * The context handed to a strategy's optional `manage` hook. Deliberately
 * NOT `StrategyContext`: `manage`'s decision is applied before the CURRENT
 * bar's `checkStopTakeProfit` runs (see `Strategy.manage` below), so unlike
 * `decideEntry`/`decideExit` (which act at a bar's CLOSE and may read
 * `candles[bar]` in full), `manage` acts at a bar's OPEN and may only read
 * data that exists at that instant: bars strictly before the engine's
 * current bar, and indicators/score computed from them.
 *
 * `bar`, `suite`, `score`, and `tier` are one bar behind the engine's current
 * bar BY CONSTRUCTION -- the engine (bar-loop.ts) builds this type from
 * values it cached at the bottom of the PREVIOUS iteration, so there is no
 * current-bar suite or score for these fields to accidentally carry.
 * `candles`, however, is the engine's FULL array (not a slice ending at
 * `bar`), the same convention `StrategyContext` already relies on: reading
 * `candles[bar]` is reading the previous bar's fully-formed candle as
 * intended, but `candles[bar + 1]` and above IS the current (or a future)
 * bar and is reachable by index. That bound is therefore a CONTRACT, not a
 * compiler guarantee (task-4-review.md N1): a `manage` implementation must
 * never index `candles` past `bar`. The current bar's OPEN is real, causal
 * information at the decision point, but it is not part of this context
 * either: the engine checks a returned price against it directly
 * (bar-loop.ts's wrong-side check) rather than exposing it here.
 */
export interface ManagementContext {
  bar: number; // one bar behind the engine's current bar; see the type header
  candles: OHLCV[]; // the engine's FULL array; reading past `bar` is a contract violation, not a type error -- see the header
  interval: string;
  suite: IndicatorSuite | null; // as of `bar` (one bar behind), null before warmup
  score: number; // composite score as of `bar`
  tier: SignalTier; // composite tier as of `bar`
}

/**
 * A rule set the backtest engines can run in place of today's hardcoded
 * score-threshold logic. Pure decision functions: a strategy reads the
 * context it is given and returns a decision, it never mutates state or
 * reaches outside ctx/config.
 */
export interface Strategy {
  name: string;
  params?: Record<string, number | string | boolean>;
  /** Called only when flat with no pending order. */
  decideEntry(ctx: StrategyContext, config: BacktestConfig): EntryDecision | null;
  /** Called only when in a position; true means exit at this bar's close. */
  decideExit(ctx: StrategyContext, config: BacktestConfig): boolean;
  /**
   * Optional per-bar position management: move the stop and/or target of an
   * already-open position. Called by the engine once per bar, before that
   * bar's checkStopTakeProfit, for a position opened on an earlier bar (never
   * on the entry bar itself, mirroring how funding accrual skips it). Absent
   * entirely for a strategy that never manages a position, so the default
   * path (no `manage`) never calls this and the engine's output is
   * unaffected.
   *
   * CAUSALITY. `ctx` is a `ManagementContext`, not a `StrategyContext`:
   * `ctx.bar`, `ctx.suite`, `ctx.score`, `ctx.tier` are one bar behind the
   * engine's current bar BY CONSTRUCTION (all as of the PREVIOUS bar; the
   * engine builds them from values cached at the bottom of the prior
   * iteration, never from the current one). `ctx.candles`, however, is the
   * engine's FULL array, so the current bar's high/low/close ARE reachable
   * at `ctx.candles[ctx.bar + 1]` -- that bound is a CONTRACT, not something
   * the type prevents (task-4-review.md N1; see `ManagementContext`'s own
   * header). The only current-bar value legitimately available at this
   * decision point is that bar's OPEN, which the engine checks a returned
   * price against itself (accepting a `stopPrice` only on the correct side
   * of it, long: below, short: above; same rule for a non-null
   * `targetPrice`, long: above, short: below) rather than handing it to
   * `manage` to read. A `manage` implementation must never index `ctx.candles`
   * past `ctx.bar`, and must never derive its decision from the current
   * bar's high, low, or close: the engine applies the decision BEFORE that
   * bar's own `checkStopTakeProfit` runs, so doing so is intrabar lookahead
   * -- the decision would be made with information that does not exist yet
   * at the bar's open, and would bias every such rule's measured expectancy
   * in a favourable direction. (This is exactly the defect task-4-review.md's
   * C1 found; `bar`/`suite`/`score`/`tier` are narrowed by the compiler so it
   * cannot recur through them, but the `candles` bound still relies on every
   * `manage` implementation honouring it.)
   */
  manage?(ctx: ManagementContext, position: OpenPosition): ManagementDecision | null;
  /**
   * Optional: applies this strategy's entry MECHANISM (order type, limit
   * offset, timeout) to another strategy's entry decisions. The engine never
   * reads it. Set by entry wrappers such as research's `withLimitEntry`, and
   * read by `randomEntryBenchmark`, so the random-entry null enters the way
   * the reference does: same fill selection, same maker fee, no taker
   * slippage. Without it a limit family's null paid taker fees plus slippage
   * on every entry while the reference paid maker, which biased the timing
   * gate toward passing (2026-10-01 review, finding M4).
   */
  entryWrapper?: (inner: Strategy) => Strategy;
}
