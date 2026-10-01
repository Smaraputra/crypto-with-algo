import type { IPaperTrade } from '@/lib/models/paper-trade';
import { bootstrapCi } from '@/lib/stats/block-bootstrap';
import { evidenceFor } from '@/lib/trade-plan/evidence';
import { BOOK_START_EQUITY, bookId, type BookKey } from './books';

/**
 * Per-book statistics over the desk's closed trades.
 *
 * Shared by the ops script and the admin API so the CLI and the dashboard can
 * never come to disagree about what "expectancy" means, the same reason
 * `defaultCostPercent` has one home.
 *
 * Win rate is computed but never targeted, per the standing programme
 * decision: a rule can win most of its trades and still lose money.
 */

export interface TrackStats {
  trades: number;
  expectancyPercent: number;
  ciLowPercent: number;
  ciHighPercent: number;
  winRate: number;
  totalPnl: number;
}

export interface BookReport {
  book: string;
  trades: number;
  symbols: number;
  /** Equity summed across the book's ledgers, against its nominal start. */
  equity: number;
  executableEquity: number;
  startEquity: number;
  engine: TrackStats | null;
  executable: TrackStats | null;
  /** Mean per-trade difference between the tracks, in percent: the cost of the lag. */
  lagCostPercent: number | null;
  byReason: Record<string, number>;
  gappedStops: number;
  stoppedOnArrival: number;
  unfilled: number;
  missingScoreBars: number;
  peakLeverage: number;
  openPositions: number;
  /** What the research record says about this rule at this interval. */
  recordedExpectancyPercent: number | null;
  evidenceStatus: string;
}

/** Bootstrap block length: a few trades, so neighbouring trades stay together. */
const BLOCK_LENGTH = 5;
const BOOTSTRAP_ITERATIONS = 2000;
const BOOTSTRAP_SEED = 42;

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

export function trackStats(returns: number[], pnls: number[]): TrackStats | null {
  if (returns.length === 0) return null;
  const ci = bootstrapCi(returns, mean, {
    iterations: BOOTSTRAP_ITERATIONS,
    meanBlockLen: BLOCK_LENGTH,
    seed: BOOTSTRAP_SEED,
  });
  return {
    trades: returns.length,
    expectancyPercent: ci.point,
    ciLowPercent: ci.low,
    ciHighPercent: ci.high,
    winRate: returns.filter((r) => r > 0).length / returns.length,
    totalPnl: pnls.reduce((s, x) => s + x, 0),
  };
}

export function buildBookReport(
  key: BookKey,
  trades: IPaperTrade[],
  ledgers: Array<{ equity: number; executableEquity: number; position: unknown }>,
  book: { missingScoreBars: number; peakLeverage: number } | null
): BookReport {
  const engineReturns = trades.map((t) => t.engine.pnlPercent);
  const enginePnls = trades.map((t) => t.engine.pnl);
  const filled = trades.filter((t) => t.executable.filled);

  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.exitReason] = (byReason[t.exitReason] ?? 0) + 1;

  return {
    book: bookId(key),
    trades: trades.length,
    symbols: ledgers.length,
    equity: ledgers.reduce((s, l) => s + l.equity, 0),
    executableEquity: ledgers.reduce((s, l) => s + l.executableEquity, 0),
    startEquity: ledgers.length * BOOK_START_EQUITY,
    engine: trackStats(engineReturns, enginePnls),
    executable: trackStats(
      filled.map((t) => t.executable.pnlPercent),
      filled.map((t) => t.executable.pnl)
    ),
    lagCostPercent:
      filled.length === 0
        ? null
        : mean(filled.map((t) => t.engine.pnlPercent - t.executable.pnlPercent)),
    byReason,
    gappedStops: trades.filter((t) => t.executable.gappedStop).length,
    stoppedOnArrival: trades.filter((t) => t.executable.stoppedOnArrival).length,
    unfilled: trades.length - filled.length,
    missingScoreBars: book?.missingScoreBars ?? 0,
    peakLeverage: book?.peakLeverage ?? 0,
    openPositions: ledgers.filter((l) => l.position !== null).length,
    recordedExpectancyPercent: evidenceFor(key.interval).expectancyPercent,
    evidenceStatus: evidenceFor(key.interval).status,
  };
}


/**
 * A realised equity curve for one book, derived from its closed trades.
 *
 * One point per closed trade, at the moment it closed. It is NOT a bar-by-bar
 * mark-to-market curve: an open position's unrealised swing is invisible here,
 * so the curve understates the drawdown actually lived through. It answers
 * "what has this book banked, and in what order", which is the question the
 * forward test is for.
 */
export function equityCurveFromTrades(
  trades: Array<Pick<IPaperTrade, 'exitTime'> & { pnl: number }>,
  startEquity: number
): Array<{ bar: number; time: number; equity: number; drawdown: number }> {
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let equity = startEquity;
  let peak = startEquity;
  return ordered.map((trade, i) => {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    return {
      bar: i,
      time: trade.exitTime,
      equity,
      drawdown: peak > 0 ? ((peak - equity) / peak) * 100 : 0,
    };
  });
}
