import type { OHLCV } from '@/types/market';
import type { IndicatorSuite } from '@/lib/indicators/types';
import type { SuperTrendResult } from '@/lib/indicators/supertrend';
import type { HtfContext, SignalTier } from '@/types/signal';
import type { MarketSession } from '@/lib/sessions';
import type { OpenPosition } from './trade-utils';
import type { PendingOrder } from './limit-orders';
import type { SnapshotBar } from './snapshot-series';
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
}
