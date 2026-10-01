import type { OHLCV } from '@/types/market';
import type { MarketSession } from '@/lib/sessions';
import type { SignalTier } from '@/types/signal';
import type { BacktestConfig, BacktestTrade } from '@/lib/backtest/types';
import type { OpenPosition } from '@/lib/backtest/trade-utils';

/**
 * Shapes for the paper desk's pure step function.
 *
 * The desk books every trade twice. The `engine` numbers are what
 * `runBarLoop` books for the same bars, so the desk stays comparable with
 * every recorded research number. The `executable` numbers are what a live
 * order would actually have got. The difference between them is the cost of
 * the lag the research never measured.
 */

/** The tier union, re-exported so the run layer need not import from two places. */
export type SignalTierOf = SignalTier;

/** What the live scorer decided on one bar, or that it never scored it. */
export interface BarDecision {
  /** false when no GlobalSignal exists for this bar: the desk may manage a position but must not open or close on a score. */
  scored: boolean;
  score: number;
  tier: SignalTier;
  session: MarketSession | null;
  /** When the signal row was written, which bounds the earliest live fill. Null when unscored. */
  signalCreatedAt: number | null;
}

/** An open position plus the executable track's own entry bookkeeping. */
export interface DeskPosition {
  engine: OpenPosition;
  /**
   * The executable entry fill: the open of the first bar at or after
   * `signalCreatedAt`. Null until that bar arrives, since at decision time it
   * lies in the future.
   */
  executableEntryPrice: number | null;
  executableEntryBar: number | null;
  /** Earliest live fill time, carried so a later bar can fill the executable entry. */
  signalCreatedAt: number;
}

export interface LedgerState {
  /** Engine-track equity. This sizes every trade, exactly as one research run does. */
  equity: number;
  /** Executable-track equity. Reported only; it never sizes anything. */
  executableEquity: number;
  position: DeskPosition | null;
}

/** The executable track's version of one closed trade. */
export interface ExecutableFill {
  /** False when the entry never filled live (the position opened and closed inside one bar). */
  filled: boolean;
  entryPrice: number;
  exitPrice: number;
  /** Bars between the decision and the live fill: 1 at 1h, more when the score arrives late. */
  entryDelayBars: number;
  /** True when price was already through the stop at the exit bar's open, so the stop could not fill at its price. */
  gappedStop: boolean;
  /** True when the entry bar's open was already beyond the stop, so the position was stopped out on arrival. */
  stoppedOnArrival: boolean;
  fees: number;
  slippageCost: number;
  pnl: number;
  pnlPercent: number;
}

export interface DeskTrade {
  engine: BacktestTrade;
  executable: ExecutableFill;
}

export interface StepInput {
  /** The candle window, ascending and contiguous on the interval grid. */
  candles: OHLCV[];
  /** Index into `candles` of the bar being stepped. */
  bar: number;
  interval: string;
  decision: BarDecision;
  /** Funding rate pinned to this bar by buildSnapshotSeries, or null. */
  fundingRate: number | null;
  config: BacktestConfig;
  /**
   * Close an open position at this bar's close as `epoch_end`, after the
   * bar's own stop and target checks, whatever the score says, and open
   * nothing this bar. Set by `runBook` on a symbol's first bar after the live
   * scorer's configVersion changes, so no ledger carries a position across
   * versions.
   */
  forceExit?: boolean;
}

/** One funding settlement charged while a position was held. */
export interface FundingCharge {
  /** Close time of the bar the settlement fell in. */
  time: number;
  rate: number;
  /** Signed, positive when the position paid. */
  amount: number;
}

export interface StepOutcome {
  state: LedgerState;
  /** Trades closed on this bar, in the order the engine books them. */
  closed: DeskTrade[];
  /** Why no entry was taken, when the rule wanted one. */
  skipped: SkipReason | null;
  /**
   * The funding charged on this bar, or null when none was. Reported because
   * the 1h snapshot row keeps changing until T+45, so a later replay would
   * read a different rate than the desk actually charged; the caller stores
   * the charge against the trade.
   */
  funding: FundingCharge | null;
}

export type SkipReason = 'missing_score' | 'session_filtered';
